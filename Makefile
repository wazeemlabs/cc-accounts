# make test runs every suite that can run here; make lint checks the shell scripts.
.PHONY: test test-shell test-python test-plugin lint

test: test-shell test-python test-plugin

test-shell:
	bash tests/cca.test.sh
	bash tests/init.test.sh

test-python:
	python3 -m unittest discover -s tests

# Needs Claude Code installed; skipped with a note where it is not.
test-plugin:
	@if command -v claude >/dev/null; then \
		claude plugin validate plugin && claude plugin test plugin; \
	else \
		echo "test-plugin: Claude Code is not installed, skipped"; \
	fi

lint:
	shellcheck -x bin/cca install.sh tests/*.sh
	python3 -m py_compile libexec/cca-setup libexec/cca-trust libexec/cca-keep-args
