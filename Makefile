COMPOSE ?= docker-compose
PODMAN ?= podman
SUDO ?= sudo
NETWORK_CONFIG ?= /etc/cni/net.d/job-tracker-network.conflist
NETWORK_NAME := job-tracker-network
PROJECT_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
COMPOSE_FILE := $(PROJECT_DIR)docker-compose.yml

.PHONY: help prepare-network start stop restart clean clean-data status logs

help:
	@printf '%s\n' \
	  'Job tracker commands:' \
	  '  make start      Prepare the Podman network and start services' \
	  '  make stop       Stop this project without removing its containers' \
	  '  make restart    Remove and recreate this project'\''s containers' \
	  '  make clean      Remove project containers/network and all unused Podman images' \
	  '  make clean-data Remove containers, network, and MongoDB data volume' \
	  '  make status     Show this project'\''s container status' \
	  '  make logs       Follow this project'\''s logs'

prepare-network:
	$(PODMAN) network exists "$(NETWORK_NAME)" || $(PODMAN) network create --driver bridge "$(NETWORK_NAME)"
	$(SUDO) python3 "$(PROJECT_DIR)scripts/normalize-podman-cni.py" "$(NETWORK_CONFIG)"

start: prepare-network
	$(COMPOSE) -f "$(COMPOSE_FILE)" up -d --build

stop:
	$(COMPOSE) -f "$(COMPOSE_FILE)" stop

restart:
	$(COMPOSE) -f "$(COMPOSE_FILE)" down --remove-orphans
	if $(PODMAN) network exists "$(NETWORK_NAME)"; then $(PODMAN) network rm "$(NETWORK_NAME)"; fi
	$(MAKE) start COMPOSE="$(COMPOSE)" PODMAN="$(PODMAN)" SUDO="$(SUDO)" NETWORK_CONFIG="$(NETWORK_CONFIG)"

clean:
	$(COMPOSE) -f "$(COMPOSE_FILE)" down --remove-orphans
	-$(PODMAN) network rm "$(NETWORK_NAME)"
	$(PODMAN) image prune --all --force

clean-data:
	@test "$(CONFIRM)" = "yes" || { \
	  echo 'Refusing to delete MongoDB data. Run: make clean-data CONFIRM=yes'; \
	  exit 1; \
	}
	$(COMPOSE) -f "$(COMPOSE_FILE)" down --remove-orphans --volumes
	-$(PODMAN) network rm "$(NETWORK_NAME)"

status:
	$(COMPOSE) -f "$(COMPOSE_FILE)" ps

logs:
	$(COMPOSE) -f "$(COMPOSE_FILE)" logs -f
