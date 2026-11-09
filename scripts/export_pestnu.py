"""Export the trained two-class detector and verify ONNX parity on a real crop."""

import argparse
from pathlib import Path
import sys

import cv2
import numpy as np
import onnx
import onnxruntime
import torch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("upstream", type=Path)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("sample", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.upstream.resolve()))
    from pestnu_yolox import Exp

    torch.set_num_threads(2)
    model = Exp().get_model().eval()
    model.load_state_dict(torch.load(args.checkpoint, map_location="cpu", weights_only=True)["model"])
    model.head.decode_in_inference = True
    photo = cv2.imdecode(np.fromfile(args.sample, dtype=np.uint8), cv2.IMREAD_COLOR)
    if photo is None or photo.shape != (416, 416, 3):
        raise ValueError("Expected a 416×416 BGR sample")
    inputs = torch.from_numpy(np.ascontiguousarray(photo.transpose(2, 0, 1)[None], dtype=np.float32))
    with torch.no_grad():
        expected = model(inputs).numpy()
        torch.onnx.export(
            model, (inputs,), str(args.output), input_names=["images"], output_names=["output"],
            opset_version=12, dynamo=False,
        )
    onnx.checker.check_model(str(args.output))
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 2
    session = onnxruntime.InferenceSession(str(args.output), sess_options=options, providers=["CPUExecutionProvider"])
    actual = session.run(["output"], {"images": inputs.numpy()})[0]
    assert actual.shape == (1, 3549, 7)
    np.testing.assert_allclose(actual, expected, rtol=0.001, atol=0.002)
    print(f"ONNX parity verified: {args.output.name}, output {actual.shape}")


if __name__ == "__main__":
    main()
