.PHONY: help test status doctor apply revert seed rule clean

help:
	@echo "test      run the test suite"
	@echo "status    show what is currently patched"
	@echo "doctor    diagnose a broken setup"
	@echo "apply     patch the detected Cursor install and seed the catalog"
	@echo "seed      seed the model catalog only (Cursor must be closed)"
	@echo "revert    restore the bundles Cursor shipped"
	@echo "rule      print the agent rule for multi-file edits"
	@echo "clean     remove caches"

test:
	node --test tests/*.test.js

status:
	node src/cli.js status

doctor:
	node src/cli.js doctor

apply:
	node src/cli.js apply

seed:
	node -e 'import("./src/seed.js").then(m => m.reportSeed(m.seedCatalog()))'

revert:
	node src/cli.js revert

rule:
	node src/cli.js rule

clean:
	find . -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
	rm -rf node_modules
