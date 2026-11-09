"""Prepare deterministic YOLOX COCO splits and demo crops from PestNu JPEG/XML."""

from argparse import ArgumentParser
from dataclasses import dataclass
from hashlib import md5, sha256
from io import BytesIO
from pathlib import Path, PurePosixPath
from random import Random
from xml.etree import ElementTree
from zipfile import ZipFile
import json
import shutil

from PIL import Image


ARCHIVE_MD5 = "e0e58eeb3e7b203c52526f9a548fb414"
SIZE = 416
SEED = 7139220
CATEGORIES = {1: "whitefly", 2: "black_aphid"}
LABELS = {
    "wh": 1,
    "ap": 2,
    "whitefly": 1,
    "whiteflies": 1,
    "white fly": 1,
    "white flies": 1,
    "black aphid": 2,
    "black aphids": 2,
}
SOURCE = {
    "title": "Yellow Glue Paper Traps Dataset",
    "url": "https://doi.org/10.5281/zenodo.7139220",
    "license": "CC BY 4.0",
    "license_url": "https://creativecommons.org/licenses/by/4.0/",
    "credit": "Nikolaos Giakoumoglou, Eleftheria-Maria Pechlivani, Nikolaos Katsoulas, and Dimitrios Tzovaras",
}


@dataclass(frozen=True)
class Box:
    category_id: int
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def area(self):
        return (self.x2 - self.x1) * (self.y2 - self.y1)

    def clip(self, left, top, right, bottom):
        x1, y1 = max(left, self.x1), max(top, self.y1)
        x2, y2 = min(right, self.x2), min(bottom, self.y2)
        if x2 <= x1 or y2 <= y1:
            return None
        return Box(self.category_id, x1 - left, y1 - top, x2 - left, y2 - top)


@dataclass(frozen=True)
class Photo:
    member: str
    width: int
    height: int
    boxes: tuple[Box, ...]

    @property
    def name(self):
        return PurePosixPath(self.member).stem


def read_photos(archive):
    members = set(archive.namelist())
    photos = {"train": [], "valid": []}
    seen = set()
    source_labels = set()
    duplicates = 0
    for member in sorted(members, key=lambda item: ("train" not in item.split("/"), item)):
        path = PurePosixPath(member)
        if path.suffix.lower() != ".jpg" or path.parent.name not in photos:
            continue
        annotation = str(path.with_suffix(".xml"))
        if annotation not in members or not path.stem.isdecimal():
            raise ValueError(f"Unexpected archive member or missing annotation: {member}")
        digest = sha256(archive.read(member)).digest()
        if digest in seen:
            duplicates += 1
            continue
        seen.add(digest)
        root = ElementTree.fromstring(archive.read(annotation))
        width = int(root.findtext("size/width"))
        height = int(root.findtext("size/height"))
        if min(width, height) < SIZE:
            raise ValueError(f"{member} is smaller than a crop")
        boxes = []
        for obj in root.findall("object"):
            name = obj.findtext("name").strip()
            source_labels.add(name)
            normalized = " ".join(name.lower().replace("_", " ").replace("-", " ").split())
            if normalized not in LABELS:
                raise ValueError(f"Unexpected label {name!r} in {annotation}")
            xmin, ymin, xmax, ymax = (
                float(obj.findtext(f"bndbox/{field}"))
                for field in ("xmin", "ymin", "xmax", "ymax")
            )
            box = Box(LABELS[normalized], max(0, xmin), max(0, ymin), min(width, xmax), min(height, ymax))
            if box.x2 <= box.x1 or box.y2 <= box.y1:
                raise ValueError(f"Invalid box in {annotation}: {box}")
            boxes.append(box)
        photos[path.parent.name].append(Photo(member, width, height, tuple(boxes)))
    if not photos["train"] or len(photos["valid"]) < 4:
        raise ValueError("The archive is missing the expected train/valid image groups")
    print(f"VOC labels: {sorted(source_labels)}; exact duplicate photos skipped: {duplicates}", flush=True)
    return photos


def pick_tiles(photo, rng, positives):
    """Choose positive tiles around real boxes and background tiles without labels."""
    tiles = []
    limit_x = photo.width - SIZE
    limit_y = photo.height - SIZE
    anchors = list(photo.boxes)
    for _ in range(8):
        rng.shuffle(anchors)
        for box in anchors:
            x = round((box.x1 + box.x2 - SIZE) / 2) + rng.randint(-132, 132)
            y = round((box.y1 + box.y2 - SIZE) / 2) + rng.randint(-132, 132)
            x, y = min(limit_x, max(0, x)), min(limit_y, max(0, y))
            if any(max(0, SIZE - abs(x - tx)) * max(0, SIZE - abs(y - ty)) > SIZE**2 * 0.70
                   for tx, ty, _ in tiles):
                continue
            hits = [source.clip(x, y, x + SIZE, y + SIZE) for source in photo.boxes]
            if not any(hit and hit.area / source.area >= 0.75
                       for hit, source in zip(hits, photo.boxes)):
                continue
            boxes = [hit for hit in hits if hit and hit.x2 - hit.x1 >= 3 and hit.y2 - hit.y1 >= 3]
            if not boxes:
                continue
            tiles.append((x, y, boxes))
            if len(tiles) == positives:
                break
        if len(tiles) == positives:
            break
    backgrounds = 0
    for _ in range(100):
        x, y = rng.randint(0, limit_x), rng.randint(0, limit_y)
        if any(box.clip(x, y, x + SIZE, y + SIZE) for box in photo.boxes):
            continue
        if any(max(0, SIZE - abs(x - tx)) * max(0, SIZE - abs(y - ty)) > SIZE**2 * 0.70
               for tx, ty, _ in tiles):
            continue
        tiles.append((x, y, []))
        backgrounds += 1
        if backgrounds == 2:
            break
    return tiles


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_split(archive, photos, output, name, positives, rng):
    images = []
    annotations = []
    counts = dict.fromkeys(CATEGORIES.values(), 0)
    image_dir = output / f"{name}2017"
    image_dir.mkdir()
    for photo in photos:
        tiles = pick_tiles(photo, rng, positives)
        with Image.open(BytesIO(archive.read(photo.member))) as jpeg:
            if jpeg.size != (photo.width, photo.height):
                raise ValueError(f"Image dimensions differ from annotation: {photo.member}")
            rgb = jpeg.convert("RGB")
        for tile_number, (x, y, boxes) in enumerate(tiles, start=1):
            filename = f"{photo.name}_{tile_number:02d}.jpg"
            rgb.crop((x, y, x + SIZE, y + SIZE)).save(image_dir / filename, quality=94)
            image_id = len(images) + 1
            tile_counts = dict.fromkeys(CATEGORIES.values(), 0)
            for box in boxes:
                annotations.append({
                    "id": len(annotations) + 1,
                    "image_id": image_id,
                    "category_id": box.category_id,
                    "bbox": [box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1],
                    "area": box.area,
                    "iscrowd": 0,
                    "segmentation": [],
                })
                category = CATEGORIES[box.category_id]
                tile_counts[category] += 1
                counts[category] += 1
            images.append({
                "id": image_id,
                "file_name": filename,
                "width": SIZE,
                "height": SIZE,
                "source_photo": photo.member,
                "source_region": [x, y, SIZE, SIZE],
                "ground_truth": tile_counts,
            })
        rgb.close()
    if not all(counts.values()):
        raise ValueError(f"The {name} split does not contain both target classes")
    dataset = {
        "info": SOURCE,
        "licenses": [{"id": 1, "name": SOURCE["license"], "url": SOURCE["license_url"]}],
        "categories": [{"id": cid, "name": label} for cid, label in CATEGORIES.items()],
        "images": images,
        "annotations": annotations,
    }
    write_json(output / "annotations" / f"{name}.json", dataset)
    stats = {
        "source_photos": len(photos),
        "tiles": len(images),
        "negative_tiles": sum(not any(image["ground_truth"].values()) for image in images),
        "boxes": counts,
    }
    print(f"{name}: {stats}", flush=True)
    return images, stats


def write_demo(output, test_images):
    demo = output / "demo"
    demo.mkdir()
    chosen = set()
    samples = []
    targets = [
        ("bo-phan", "Bẫy có bọ phấn", "whitefly", 2),
        ("rep-den", "Bẫy có rệp đen", "black_aphid", 2),
        ("hai-loai", "Bẫy có hai loại", "mixed", 6),
        ("nen-bay", "Vùng bẫy không có nhãn", "background", 0),
    ]
    for ident, title, kind, desired in targets:
        def score(image):
            white, black = (image["ground_truth"][name] for name in CATEGORIES.values())
            matching = {
                "whitefly": white > 0 and black == 0,
                "black_aphid": black > 0 and white == 0,
                "mixed": white > 0 and black > 0,
                "background": white + black == 0,
            }[kind]
            return (not matching, abs(white + black - desired), image["file_name"])

        sample = min((image for image in test_images if image["source_photo"] not in chosen), key=score)
        if score(sample)[0]:
            raise ValueError(f"Test split lacks a suitable demo image for {kind}")
        chosen.add(sample["source_photo"])
        shutil.copyfile(output / "test2017" / sample["file_name"], demo / f"{ident}.jpg")
        samples.append({
            "id": ident,
            "title": title,
            "image": f"/static/ai/demo/{ident}.jpg",
            "ground_truth": sample["ground_truth"],
            "source_photo": sample["source_photo"],
            "source_region": sample["source_region"],
        })
    write_json(demo / "demo.json", {"samples": samples, "source": SOURCE})


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    with args.archive.open("rb") as downloaded:
        checksum = md5(usedforsecurity=False)
        for chunk in iter(lambda: downloaded.read(1024 * 1024), b""):
            checksum.update(chunk)
    if checksum.hexdigest() != ARCHIVE_MD5:
        raise ValueError("The archive checksum differs from the public Zenodo record")
    args.output.mkdir(parents=True, exist_ok=True)
    if any(args.output.iterdir()):
        raise ValueError("Use an empty output directory")
    (args.output / "annotations").mkdir()
    rng = Random(SEED)
    with ZipFile(args.archive) as archive:
        photos = read_photos(archive)
        validation = photos["valid"]
        rng.shuffle(validation)
        midpoint = len(validation) // 2
        _, train = write_split(archive, photos["train"], args.output, "train", 8, rng)
        _, val = write_split(archive, validation[:midpoint], args.output, "val", 10, rng)
        test_images, test = write_split(archive, validation[midpoint:], args.output, "test", 10, rng)
    write_demo(args.output, test_images)
    write_json(args.output / "manifest.json", {
        "source": SOURCE,
        "archive_md5": ARCHIVE_MD5,
        "tile_size": SIZE,
        "categories": CATEGORIES,
        "seed": SEED,
        "splits": {"train": train, "val": val, "test": test},
    })


if __name__ == "__main__":
    main()
