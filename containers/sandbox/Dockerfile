# cybercode sandbox image: the tools an offensive run actually reaches for.
#
# ponytail: ubuntu + curated, not kali-rolling. Kali ships every tool but costs
# several GB and a slow first pull; this stays a few hundred MB of apt plus the
# published static binaries. Swap the base for kali when the tool list outgrows
# the curated set.
#
# ponytail: every Go scanner is a published release, not `go install`. Compiling
# nuclei here needs more memory than a laptop has; the binary is identical and
# the download is a few seconds. Assets are resolved through the releases API so
# a bumped version never silently 404s, and so the Dockerfile does not pin a
# version that goes stale.
#
# ponytail: no BuildKit syntax or --mount=type=cache — the operator's docker may
# not have buildx. Reintroduce both when CI is the only place this builds.
FROM ubuntu:24.04

# shell + the basics the wrappers reach for, then the offensive toolset.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget git jq file unzip tar \
      nmap nikto sqlmap whois dnsutils \
      smbclient smbmap \
      python3 python3-pip python3-venv \
      exiftool binwalk \
      hydra john hashcat netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Static Go scanners, straight from their release assets.
RUN set -eux; \
    fetch() { \
      repo="$1"; pattern="$2"; \
      url="$(curl -fsSL "https://api.github.com/repos/${repo}/releases/latest" \
        | grep -o '"browser_download_url": *"[^"]*"' \
        | sed 's/.*"\(https[^"]*\)".*/\1/' \
        | grep -iE "${pattern}" \
        | grep -viE '\.(sha256|deb|rpm|sig)$' \
        | head -n1)"; \
      test -n "${url}"; \
      curl -fsSL -o /tmp/tool.bin "${url}"; \
      mkdir -p /tmp/asset; \
      case "${url}" in \
        *.zip) unzip -o -q /tmp/tool.bin -d /tmp/asset ;; \
        *.tar.gz) tar -xzf /tmp/tool.bin -C /tmp/asset ;; \
        *) echo "unsupported asset: ${url}" && exit 1 ;; \
      esac; \
      rm -rf /tmp/tool.bin; \
    }; \
    fetch projectdiscovery/nuclei    'linux[-_]amd64.*\.zip$'; \
    fetch projectdiscovery/httpx     'linux[-_]amd64.*\.zip$'; \
    fetch projectdiscovery/naabu     'linux[-_]amd64.*\.zip$'; \
    fetch projectdiscovery/katana    'linux[-_]amd64.*\.zip$'; \
    fetch projectdiscovery/subfinder 'linux[-_]amd64.*\.zip$'; \
    fetch hahwul/dalfox              'linux[-_](amd64|x86_64).*\.tar\.gz$'; \
    fetch ffuf/ffuf                  'linux[-_]amd64.*\.tar\.gz$'; \
    fetch OJ/gobuster                'linux[-_](x86_64|amd64).*\.tar\.gz$'; \
    # Releases vary between a flat archive and one wrapped in a versioned
    # directory, so take the executables wherever they landed.
    for f in $(find /tmp/asset -type f -perm -u+x ! -name '*.sh'); do \
      cp "$f" "/usr/local/bin/$(basename "$f")"; \
    done; \
    rm -rf /tmp/asset; \
    chmod +x /usr/local/bin/*; \
    ls -1 /usr/local/bin

# Non-root so files the run writes into the bind mount stay owned by the
# operator, not root. The base image already ships `ubuntu` at 1000, so only
# mint a user when the requested uid is free.
#
# ponytail: HOME is /workspace rather than the passwd home — `bash -lc` needs
# one, and the tools we install land on /usr/local/bin which is already on the
# login PATH. Point it at the real home if a profile ever matters.
ARG UID=1000
ARG GID=1000
RUN if ! getent passwd "${UID}" >/dev/null; then \
      groupadd -g "${GID}" sandbox && useradd -m -u "${UID}" -g "${GID}" sandbox; \
    fi \
    && mkdir -p /workspace \
    && chown -R "${UID}:${GID}" /workspace

ENV HOME=/workspace
WORKDIR /workspace
USER "${UID}"

# Keep-alive target: cybercode starts the container with `sleep infinity` and
# drives commands through `docker exec`, so no entrypoint is defined here.
CMD ["sleep", "infinity"]
