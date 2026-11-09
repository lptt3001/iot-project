"""YOLOX-Nano experiment for the two PestNu sticky-trap categories."""

import os

from exps.default.yolox_nano import Exp as NanoExp


class Exp(NanoExp):
    def __init__(self):
        super().__init__()
        self.exp_name = "ptit_pestnu_nano"
        self.num_classes = 2
        self.data_dir = os.environ["PTIT_AI_COCO_DIR"]
        self.output_dir = os.environ["PTIT_AI_RUNS_DIR"]
        self.train_ann = "train.json"
        self.val_ann = "val.json"
        self.test_ann = "test.json"
        self.data_num_workers = 0
        self.max_epoch = 20
        self.warmup_epochs = 1
        self.no_aug_epochs = 3
        self.eval_interval = 1
        self.print_interval = 20
        self.save_history_ckpt = False
        self.random_size = (13, 13)
        self.mosaic_prob = 0.3
        self.mosaic_scale = (0.8, 1.2)
        self.degrees = 0.0
        self.shear = 0.0
        self.seed = 47
