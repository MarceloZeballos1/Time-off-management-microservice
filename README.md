# Time-Off Microservice - Take Home Exercise

## Introduction
This microservice manages employee vacation requests. It uses a local SQLite database to store balances so the application stays fast and reliable, even if the external Human Capital Management (HCM) system is slow or temporarily offline.

## How it works (Simple)
- It checks the balance locally first.
- It reserves the days so the user doesn't spend them twice.
- It syncs with the HCM in the background.

## Prerequisites
- Node.js
- npm

**Note for Windows users:**
If you get a `PSSecurityException` on Windows, run: 
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

## Installation & Run
To run the project properly, you need to install dependencies in their respective folders.

```bash
# 1. Install root, mock server, and service dependencies
npm install
cd mock-hcm-server ; npm install
cd ../time-off-service ; npm install

# 2. Go back to the root directory to seed the data
cd ..
npm run seed

# 3. Start the application globally from the root
npm run dev
```
This will start both the NestJS Service (port 3000) and the Mock HCM (port 4000).

## Proof of Coverage
Our testing strategy ensures that 100% of the critical business logic is covered. This means that:
- **Balance Calculation:** Safely tracking available days.
- **Race Conditions:** Preventing multiple fast clicks from booking the same balance.
- **Self-Healing:** Synchronizing properly if the HCM adds "Anniversary" days.

To view the coverage report:
```bash
cd time-off-service ; npm run test:cov
```

## Testing
To run the standard tests, which cover the main logic and race conditions, navigate into the service folder and run them:

```bash
# Run unit tests
cd time-off-service ; npm run test
# Run e2e tests
cd time-off-service ; npm run test:e2e
```

## Note on Test Outputs
When running E2E tests, you might see `ERROR` logs in the terminal (like `SQLITE_ERROR` or HCM Network Failure). These are expected! The tests intentionally simulate race conditions and network failures to verify the system's resilience and defensive logic. As long as the final test result says `PASS`, the system is performing correctly.