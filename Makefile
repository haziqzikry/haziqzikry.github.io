.PHONY: build serve new-post clean install

install:
	npm install

build:
	node build.js

serve:
	node watch.js

new-post:
	@test -n "$(SLUG)" || (echo "usage: make new-post SLUG=my-post" && exit 1)
	@mkdir -p content/posts/$(SLUG)
	@printf -- "---\ntitle: \"$(SLUG)\"\ndate: %s\nsummary: \"\"\ntags: []\n---\n\n" "$$(date +%F)" \
		> content/posts/$(SLUG)/index.md
	@echo "created content/posts/$(SLUG)/index.md"

clean:
	rm -rf public
