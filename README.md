# Getting started

```bash
git clone https://github.com/romanzy-1612/modern-ts-lib-starter.git PROJECTNAME
cd PROJECTNAME
yarn install
yarn start
```

Replace placeholders such as <<LIB-NAME>>, <<DESCRIPTION>>, <<AUTHOR>>, <<GIT-USERNAME>>. You can search and replace with regex pattern <<.\*>>

# Whats included

- Jest testing with watch mode
- Rollup bunding with SWC to ES and UMD modules (NOTE: not sure if UMD actually works)
- Minimal eslint and prettier configuration
- package.json is ready for publishing to npm
- Templates with placeholders: readme, license, bug report, feature request

# Create example

run `yarn create vite example` and reference your library with

```typescript
import { DummyClass } from '../../src';
console.log(DummyClass);
```

# Credits

Initial project setup was taken from [peer-lite](https://github.com/skyllo/peer-lite) project. Thank you skyllo!

# TODO

- [ ] typedoc generation
- [ ] ci to keep packages upto date, coverage report

_delete above here to start writing your README_

# <<LIB-NAME>>

Description

# Features

# Installation

```bash
yarn install <<LIB-NAME>>
```

```bash
yarn add <<LIB-NAME>>
```

# Usage

# Examples

See more examples [here](example)

# API

# Testing

```bash
yarn t
```

or

```bash
yarn test:watch
```
