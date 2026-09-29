#!/usr/bin/env python3
"""Run every Ontrak Sync backend test in one process.

The estate's other Python tests are run one file at a time; this exists because
there are several of them and they all import the same package, so loading them
once is both faster and closer to how the API's own startup works. It discovers
`test_*.py`, so a new module is picked up without being registered anywhere. It is plain
`unittest` all the way down — no pytest — so it runs anywhere Python 3.11+ does,
which is the whole point of not depending on the test tooling being installed in
the container that runs the service.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.discover(str(HERE), pattern="test_*.py")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
