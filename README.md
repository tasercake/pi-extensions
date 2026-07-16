# pi-extensions

Extensions for [pi](https://pi.dev/) for my (personal) daily use.

## Install/update

Install the complete package from the unpinned git source:

```sh
pi install git:github.com/tasercake/pi-extensions
```

Update installed extensions and root dependencies with:

```sh
pi update --all
```

Git installs pinned with `@tag` or `@commit`, and version-pinned npm installs, do not advance when updating. Use the unpinned git flow above to receive repository updates.

## Extensions

- [Agentmemory](extensions/agentmemory/README.md) — namespaced memory tools, bounded automatic recall/capture, and automatic connection or startup of one shared persistent Agentmemory daemon.
