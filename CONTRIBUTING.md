# Contributing to Vessel

Thank you for your interest in contributing to Vessel! As a local-first desktop application built with Rust and SolidJS/Tauri, we welcome issues, feature requests, and code contributions.

## Development Setup

To build and run Vessel locally, you need the following prerequisites:

1. **Rust Toolchain:**
   * Install Rustup via [rustup.rs](https://rustup.rs/).
   * Build target requires a C compiler and standard developer tools for your platform.
2. **Node.js (v18+):**
   * Download and install Node.js from [nodejs.org](https://nodejs.org/).
3. **Tauri Dependencies:**
   * Please follow the Tauri setup guide for your operating system: [tauri.app Prerequisites](https://tauri.app/start/prerequisites/).

### Clone and Launch

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/vessel.git
   cd vessel
   ```
2. Install frontend dependencies:
   ```bash
   npm install
   ```
3. Run the application in development mode:
   ```bash
   npm run dev
   ```
   *This starts the Vite local server and opens the native Tauri desktop window.*

## Project Structure

*   `/src`: Frontend source code (SolidJS + TypeScript + Tailwind/CSS).
*   `/src-tauri`: Backend source code (Rust application & Tauri configuration).
*   `/src-tauri/src/ssh`: SSH connection logic and SFTP client code.

## Submitting Pull Requests

1. **Branch Naming:** Use descriptive branch names: `feature/your-feature` or `bugfix/issue-description`.
2. **Linting and Format:**
   * Run Rust formatting before committing: `cargo fmt --all` inside `/src-tauri`.
   * Run linter: `npm run lint` (when configured).
3. **Tests:** Ensure that existing tests compile and pass. Add tests for new Rust functions.
4. **Commit Messages:** Follow standard semantic commit guidelines: `feat: add docker manager dashboard` or `fix: handle invalid port connections`.

## Code of Conduct

Please review and adhere to our [Code of Conduct](CODE_OF_CONDUCT.md) in all community interactions.
