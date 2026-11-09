import unittest
from scripts.trap_detector import merge, score, tiles


class TrapDetectionTests(unittest.TestCase):
    def test_overlapping_views_cover_camera_frame_and_its_edges(self):
        regions = tiles(640, 485)
        self.assertEqual(len(regions), 6)
        for x, y in [(0, 0), (639, 484), (319, 242), (320, 320), (160, 164)]:
            self.assertTrue(any(a <= x < c and b <= y < d for a, b, c, d in regions))
        self.assertEqual(tiles(240, 240), [(0, 0, 240, 240)])

    def test_duplicate_views_collapse_without_merging_neighbor_insects(self):
        predictions = [
            {"class_id": 0, "confidence": .8, "xyxy": [10, 10, 30, 30]},
            {"class_id": 0, "confidence": .9, "xyxy": [11, 10, 31, 30]},
            {"class_id": 0, "confidence": .7, "xyxy": [35, 10, 55, 30]},
        ]
        result = merge(predictions)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["confidence"], .9)

    def test_wrong_species_and_duplicate_count_are_penalized(self):
        ground_truth = {"frame": [{"class_id": 0, "xyxy": [10, 10, 30, 30]},
                                  {"class_id": 1, "xyxy": [40, 40, 60, 60]}]}
        predictions = {"frame": [
            {"class_id": 0, "confidence": .9, "xyxy": [10, 10, 30, 30]},
            {"class_id": 0, "confidence": .8, "xyxy": [10, 10, 30, 30]},
            {"class_id": 2, "confidence": .95, "xyxy": [40, 40, 60, 60]},
        ]}
        result = score(predictions, ground_truth, [.7] * 6)["overall"]
        self.assertEqual((result["tp"], result["fp"], result["fn"]), (1, 2, 1))

    def test_empty_trap_false_alarm_does_not_count_as_a_correct_detection(self):
        predictions = {"empty": [{"class_id": 0, "confidence": .9, "xyxy": [10, 10, 30, 30]}]}
        result = score(predictions, {"empty": []}, [.7] * 6)["overall"]
        self.assertEqual(result["fp"], 1)
        self.assertEqual(result["precision"], 0)
        self.assertIsNone(result["recall"])


if __name__ == "__main__":
    unittest.main()
