COMPOSE ?= docker-compose
PROJECT_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
COMPOSE_FILE := $(PROJECT_DIR)docker-compose.yml
COMPOSE_ENV_FILE := $(PROJECT_DIR).env
COMPOSE_ENV_ARGS := $(if $(wildcard $(COMPOSE_ENV_FILE)),--env-file "$(COMPOSE_ENV_FILE)",)

.PHONY: help start stop restart clean clean-data status logs

help:
	@printf '%s\n' \
	  'Job tracker commands:' \
	  '  make start      Build and start the app container' \
	  '  make stop       Stop this project without removing its containers' \
	  '  make restart    Remove and recreate this project'\''s containers' \
	  '  make clean      Remove this project'\''s containers' \
	  '  make clean-data Remove containers and the JSON data volume' \
	  '  make status     Show this project'\''s container status' \
	  '  make logs       Follow this project'\''s logs'

start:
	$(COMPOSE) $(COMPOSE_ENV_ARGS) -f "$(COMPOSE_FILE)" up -d --build

stop:
	$(COMPOSE) $(COMPOSE_ENV_ARGS) -f "$(COMPOSE_FILE)" stop

restart:
	$(COMPOSE) $(COMPOSE_ENV_ARGS) -f "$(COMPOSE_FILE)" down --remove-orphans
	$(MAKE) start COMPOSE="$(COMPOSE)"

clean:
	$(COMPOSE) $(COMPOSE_ENV_ARGS) -f "$(COMPOSE_FILE)" down --remove-orphans

clean-data:
	@test "$(CONFIRM)" = "yes" || { \
	  echo 'Refusing to delete JSON application data. Run: make clean-data CONFIRM=yes'; \
	  exit 1; \
	}
	$(COMPOSE) $(COMPOSE_ENV_ARGS) -f "$(COMPOSE_FILE)" down --remove-orphans --volumes

status:
	$(COMPOSE) $(COMPOSE_ENV_ARGS) -f "$(COMPOSE_FILE)" ps

logs:
	$(COMPOSE) $(COMPOSE_ENV_ARGS) -f "$(COMPOSE_FILE)" logs -f
