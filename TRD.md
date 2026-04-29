# Technical Requirement Document (TRD): Time-Off Microservice

**Author:** Marcelo Santiago Zeballos Murillo  
**Date:** April 28, 2026  
**Status:** Final / Implemented  

---

## 1. Project Overview

In the ExampleHR system, the external Human Capital Management (HCM) manages employee vacation days. Because external systems can be slow or go down, ExampleHR needs a way to handle time-off requests quickly and reliably.

This document explains the architecture of our microservice. Our goal is to let employees request time off without waiting for the HCM, while making sure they don't request more days than they have. We do this by saving the changes locally first and updating the HCM in the background.

---

## 2. Architecture: "Reservation-First" approach

To make the app fast and reliable, we use a local database (SQLite) to keep track of the balances. 

### How requests are handled:
1. **Local Validation:** Our local database keeps track of `totalDays` (the actual balance) and `reservedDays` (days currently in process). The available balance is calculated as `totalDays - reservedDays`.
2. **Reserving Days:** When a user requests time off, we check if they have enough available balance. If they do, we immediately add the requested days to `reservedDays` and save the request as `PENDING`. The user gets a success response right away.
3. **Background Sync:** A background process sends the `PENDING` request to the HCM.
   - **Approved:** If the HCM approves, we decrease `totalDays` and reset the `reservedDays`. The request is marked `APPROVED`.
   - **Rejected:** If the HCM rejects the request, we just remove the `reservedDays` so the balance is restored. The request is marked `REJECTED`.

This makes sure the user doesn't accidentally spend the same days twice while waiting for the HCM.

---

## 3. Handling Errors and Race Conditions

We designed the system to handle common issues:

### 3.1. HCM is down or slow
* **Problem:** The HCM takes too long or returns an error.
* **Fix:** The request stays in the queue and we try again automatically up to 3 times. If it still fails, it stays `PENDING` until a background job can retry it later.

### 3.2. Work Anniversaries (HCM updates balance directly)
* **Problem:** The HCM adds vacation days for work anniversaries, making our local database outdated.
* **Fix:** We have a batch sync process (`POST /sync/batch`) that checks the HCM balance. If the HCM has more days than our local database, we update our local balance to match the HCM.

### 3.3. Race Conditions (Clicking twice)
* **Problem:** A user clicks the submit button multiple times really fast.
* **Fix:** We use TypeORM with SQLite and wrap the process in a transaction. This processes the requests one at a time, so the balance calculation is always correct and never goes below zero.

---

## 4. Analysis of Alternatives

Before deciding on the Reservation-First pattern, we evaluated other common approaches for integrating with the external HCM:

### 4.1. Direct Sync (Calling the HCM API on every request)
* **How it works:** A user requests time off, the service asks the HCM for approval, and then responds to the user.
* **Why we rejected it:** This creates a poor User Experience (UX). If the HCM represents a slow legacy system or goes offline, the employee’s request either times out or fails entirely. The application becomes completely dependent on the HCM's uptime, causing high latency.

### 4.2. Polling (Periodic checks)
* **How it works:** The system periodically asks the HCM "Are there any new balance updates?" every few seconds or minutes.
* **Why we rejected it:** It is highly inefficient for real-time consistency. If an employee tries to book multiple vacations in quick succession before the next polling cycle, they could overdrive their balance. Also, frequent polling spams the external HCM API unnecessarily.

### Conclusion & Justification
Our local reservation combined with background sync acts as the most defensive and robust solution for ExampleHR. By strictly using both `employeeId` and `locationId`, we maintain immediate local validation. The user gets a rapid response, and the system guarantees **no overdrafts** by booking days up-front locally.

---

## 5. Tech Stack Choices

* **NestJS:** We used NestJS because it helps organize the code well and makes it easy to test.
* **TypeORM + SQLite:** SQLite is a simple, lightweight database that works great for this project. It supports transactions easily without needing a complicated setup.

---

## 5. Setup Instructions

Please refer to the `README.md` for the quick start guide. The steps to run the project and the tests are detailed there.
