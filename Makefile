.PHONY: build lint lint-fix format format-check test test-watch test-coverage type-check quality clean install

build:
	npm run build

lint:
	npm run lint

lint-fix:
	npm run lint:fix

format:
	npm run format

format-check:
	npm run format:check

test:
	npm run test

test-watch:
	npm run test:watch

test-coverage:
	npm run test:coverage

type-check:
	npm run type-check

quality:
	npm run quality

clean:
	rm -rf dist coverage *.tsbuildinfo

install:
	npm install
