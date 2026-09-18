"""``python -m ontrak`` — same entry point as the ``ontrak`` console script.

Both exist because operators reach for different things: the console script after
``pip install -e .``, and ``python -m ontrak`` when they are working from a checkout
with a virtualenv. Keeping them identical avoids the class of bug where a Makefile
target works and a documented command does not.
"""

from __future__ import annotations

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
