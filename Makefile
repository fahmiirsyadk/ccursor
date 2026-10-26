.PHONY: help install test lint status doctor apply revert clean

PY ?= python3
VENV ?= .venv
BIN := $(VENV)/bin

help:
	@echo "install   create venv and install in editable mode"
	@echo "test      run the test suite"
	@echo "status    show what is currently patched"
	@echo "doctor    diagnose a broken setup"
	@echo "apply     patch the detected Cursor install"
	@echo "revert    restore the bundles Cursor shipped"
	@echo "clean     remove venv and caches"

install:
	$(PY) -m venv $(VENV)
	$(BIN)/pip install -e '.[dev]'

test:
	PYTHONPATH=src $(BIN)/python -m pytest -q

status:
	PYTHONPATH=src $(BIN)/python -m cursor_byok.cli status

doctor:
	PYTHONPATH=src $(BIN)/python -m cursor_byok.cli doctor

apply:
	PYTHONPATH=src $(BIN)/python -m cursor_byok.cli apply

revert:
	PYTHONPATH=src $(BIN)/python -m cursor_byok.cli revert

clean:
	rm -rf $(VENV) .pytest_cache src/*.egg-info
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
