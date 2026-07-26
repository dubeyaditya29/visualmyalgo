# VisualMyAlgo

## Introduction
VisualMyAlgo is a desktop-first code tracing workspace. Paste JavaScript, Python, C++, or Java, run it in an isolated worker, and step through the resulting execution timeline with source highlighting, variables, call stacks, console output, and breakpoints.

[![GitHub contributors](https://img.shields.io/github/contributors/algorithm-visualizer/algorithm-visualizer.svg?style=flat-square)](https://github.com/algorithm-visualizer/algorithm-visualizer/graphs/contributors)
[![GitHub license](https://img.shields.io/github/license/algorithm-visualizer/algorithm-visualizer.svg?style=flat-square)](https://github.com/algorithm-visualizer/algorithm-visualizer/blob/master/LICENSE)

## Development

```bash
npm install
npm run dev
```

The web app runs on `http://localhost:3000` and the API on `http://localhost:8080`.

The API needs a running Docker daemon to execute user programs. It uses short-lived containers with networking disabled, a read-only filesystem, dropped capabilities, and CPU, memory, process, timeout, and output limits. See [apps/api/docker/README.md](apps/api/docker/README.md) before deploying the executor.

Run checks with:

```bash
npm test
npm run typecheck
npm run build
```


## Key Features

- Paste-ready Monaco editor with JavaScript, Python, C++, and Java templates.
- Execution timeline with pause, restart, previous/next, step-over, step-out, seek, and speed controls.
- Automatic line trace, call-stack view, variable inspector surface, console output, errors, and breakpoints.
- Explicit Run by default plus opt-in debounced auto-run.
- Accessible light and dark modes.
- No accounts and no code persistence.

## algorithms
In this repository, you'll find visualizations of algorithms showcased in the website's side menu. Contributions here directly impact the educational content available on the platform.   https://github.com/algorithm-visualizer/algorithms</li>
</ul>


## tracers
Explore the various visualization libraries in different programming languages. These libraries extract visualization commands from code.
https://github.com/search?q=topic%3Avisualization-library+org%3Aalgorithm-visualizer&type=Repositories</li>
</ul>

## Live Demo
Learning an algorithm gets much easier with visualizing it. Don't get what we mean? Check it out:

[**algorithm-visualizer.org**![Screenshot](https://raw.githubusercontent.com/algorithm-visualizer/algorithm-visualizer/master/branding/screenshot.png)](https://algorithm-visualizer.org/)

## Contributing

Our project consists of multiple repositories, each playing a crucial role in the Algorithm Visualizer ecosystem. If you're interested in contributing, check out the guidelines for the specific repository:


- [**`algorithm-visualizer`**](https://github.com/algorithm-visualizer/algorithm-visualizer) is a web app written in React. It contains UI components and interprets commands into visualizations. Check out [the contributing guidelines](CONTRIBUTING.md).

- [**`server`**](https://github.com/algorithm-visualizer/server) serves the web app and provides APIs that it needs on the fly. (e.g., GitHub sign in, compiling/running code, etc.)

- [**`algorithms`**](https://github.com/algorithm-visualizer/algorithms) contains visualizations of algorithms shown on the side menu of the website.

- [**`tracers.*`**](https://github.com/search?q=topic%3Avisualization-library+org%3Aalgorithm-visualizer&type=Repositories) are visualization libraries written in each supported language. They extract visualizing commands from code.

Ready to contribute? Explore the repositories and become part of the Algorithm Visualizer community!
