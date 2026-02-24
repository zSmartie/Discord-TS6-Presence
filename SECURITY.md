# Security Policy

## Supported Versions

This project currently supports the latest `main` branch.

## Reporting a Vulnerability

Please do not open public issues for security vulnerabilities.

Report vulnerabilities privately to the maintainer and include:

- Impact summary
- Steps to reproduce
- Affected version/commit
- Suggested mitigation (if available)

## Secrets and Credentials

This project uses environment variables for credentials.
Never commit `.env` or real tokens/passwords.
If credentials are exposed, rotate them immediately.