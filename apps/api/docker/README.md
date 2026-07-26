# Runner images

The API launches official language images with networking disabled, a read-only root filesystem, dropped capabilities, memory/CPU/process limits, and a short-lived bind mount containing the submitted source.

Before production, mirror and pin the images used in `src/runs.ts` to your own registry. Do not grant the API process unrestricted Docker access in a shared environment; deploy it on a dedicated worker host or behind a container runtime service.
