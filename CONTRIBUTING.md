# Contributing to Vite HTTP/2 Proxy Plugin

Thank you for your interest in contributing to Vite HTTP/2 Proxy Plugin! This document provides guidelines for contributing to the project.

## Development Setup

1. Fork and clone the repository
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Build the project:
   ```bash
   pnpm build
   ```
4. Run tests:
   ```bash
   pnpm test
   ```

## Development Workflow

1. Create a new branch for your feature or fix:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and ensure tests pass:
   ```bash
   pnpm test
   ```

3. Build the project to ensure no TypeScript errors:
   ```bash
   pnpm build
   ```

4. Commit your changes following conventional commits:
   ```
   feat: add new feature
   fix: resolve bug
   docs: update documentation
   test: add tests
   refactor: improve code structure
   ```

5. Push your branch and create a pull request

## Testing

- Write tests for new features in the `test` directory
- Ensure all tests pass before submitting a PR
- Include both unit and integration tests where appropriate

## Code Style

- TypeScript strict mode is enabled
- Use meaningful variable and function names
- Add JSDoc comments for public APIs
- Follow existing code patterns

## Debugging

Enable debug logging:
```bash
DEBUG=vite:http2-proxy pnpm test
```

## Pull Request Process

1. Update documentation if needed
2. Add tests for new functionality
3. Ensure all tests pass
4. Update CHANGELOG.md with your changes
5. Request review from maintainers

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include reproduction steps for bugs
- Provide environment details (Node version, OS, etc.)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.