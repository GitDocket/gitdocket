FROM oven/bun:1.3.14 AS bun
FROM node:24.2.0-bookworm AS node24
FROM node:22.14.0-bookworm AS node22
FROM ubuntu:24.04
COPY --from=node22 /usr/local /usr/local
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=node24 /usr/local/bin/node /opt/node24/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends build-essential curl file git procps ruby python3 ca-certificates locales && rm -rf /var/lib/apt/lists/* \
    && npm install --global npm@11.17.0 \
    && useradd --create-home --shell /bin/bash linuxbrew \
    && mkdir -p /home/linuxbrew/.linuxbrew /work /output \
    && chown -R linuxbrew:linuxbrew /home/linuxbrew /work /output
USER linuxbrew
RUN git clone https://github.com/Homebrew/brew /home/linuxbrew/.linuxbrew/Homebrew \
    && git -C /home/linuxbrew/.linuxbrew/Homebrew checkout 570982948a8a194f0f42f43f4a5bce2d1c9f64cb \
    && mkdir -p /home/linuxbrew/.linuxbrew/bin \
    && ln -s ../Homebrew/bin/brew /home/linuxbrew/.linuxbrew/bin/brew
ENV PATH="/home/linuxbrew/.linuxbrew/bin:${PATH}" HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1
RUN brew --version && brew ruby -e 'puts RUBY_PLATFORM'
WORKDIR /work
