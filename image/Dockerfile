FROM --platform=linux/amd64 debian:13-slim

ARG BROOD_UID=1000
ARG BROOD_GID=1000
ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        iproute2 \
        less \
        openssh-server \
        passwd \
        procps; \
    rm -f /etc/ssh/ssh_host_*; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --gid "${BROOD_GID}" --non-unique brood; \
    useradd \
        --uid "${BROOD_UID}" \
        --gid brood \
        --home-dir /home/brood \
        --create-home \
        --shell /bin/bash \
        brood; \
    passwd --delete brood; \
    install -d -o root -g root -m 0755 /run/sshd /etc/ssh/host_keys /srv/scenario; \
    install -d -o brood -g brood -m 0700 /home/brood/.ssh

WORKDIR /srv/scenario
EXPOSE 22
STOPSIGNAL SIGTERM
