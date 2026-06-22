# LessGo - SJSU Ridesharing

> **Campus carpooling, reimagined.** ML-powered matching, SJSU-verified drivers, rides that actually make sense for students.

---

## 🎬 Walkthrough & Demo

### 🎥 Full Walkthrough Video

<a href="https://youtu.be/l79FVVxRbPU" target="_blank">
  <img src="https://img.youtube.com/vi/l79FVVxRbPU/maxresdefault.jpg" alt="LessGo Walkthrough Video" width="800"/>
</a>

> Click thumbnail above to watch full walkthrough on YouTube.

### 📱 App Demo Simulation

<a href="https://youtube.com/shorts/KEm_HKYem6s?feature=share" target="_blank">
  <img src="https://img.youtube.com/vi/KEm_HKYem6s/maxresdefault.jpg" alt="LessGo App Demo" width="400"/>
</a>

> Click thumbnail above to watch app demo simulation on YouTube.

**Walkthrough covers:**
- Onboarding
- Searching and booking a ride as a rider
- Posting a trip as a driver
- Real-time chat and location tracking
- Stripe payment flow

---

![Swift](https://img.shields.io/badge/Swift-F05138?style=for-the-badge&logo=swift&logoColor=white)
![SwiftUI](https://img.shields.io/badge/SwiftUI-0063D1?style=for-the-badge&logo=swift&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=for-the-badge&logo=kubernetes&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-2088FF?style=for-the-badge&logo=githubactions&logoColor=white)
![Stripe](https://img.shields.io/badge/Stripe-635BFF?style=for-the-badge&logo=stripe&logoColor=white)

---

## Overview

LessGo is a ridesharing platform built specifically for SJSU students. Drivers post scheduled trips; riders search and book rides that fit their schedule. An ML matching pipeline ranks results by route compatibility, and all users are verified via SJSU student ID before they can participate.

---

## Features

- **SJSU ID Verification** — All drivers and riders must verify a valid SJSU student ID before accessing the platform. Verification uses ML-based document processing.
- **ML-Powered Matching** — RShareForm embeddings rank trips by route compatibility, not just proximity.
- **Posted Rides** — Drivers publish scheduled trips with departure time, route, and available seats. Riders browse and book asynchronously.
- **Driver Approval Flow** — Bookings require explicit driver approval (`pending → approved/rejected`), preventing surprise pickups.
- **Dynamic Fare Calculation** — Fares account for straight-line distance, detour surcharges, and multi-rider discounts via a dedicated cost service.
- **Multi-Rider Discount Freeze** — At T-1h before departure, discounts are locked in and distributed via savings-pool redistribution across confirmed riders.
- **Real-Time Chat & Tracking** — In-app chat and live location tracking during active trips.
- **Safety Monitoring** — A dedicated safety service monitors route deviation and speed anomalies in real time, alerting riders and drivers when anomalies are detected.
- **Stripe Payments** — Payment is captured only on trip completion; Stripe handles all card processing.
- **Recurring Trip Support** — Drivers can post trips on recurring schedules; riders can book regular commutes.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| iOS Frontend | Swift 5, SwiftUI, MapKit |
| API Gateway | Node.js 22, Express, `http-proxy-middleware` |
| Backend Services | Node.js 22, TypeScript, Express |
| ML Services | Python 3 (embedding service, routing service) |
| Database | PostgreSQL + PostGIS via Supabase |
| Cache | Redis |
| Auth | JWT (`jsonwebtoken`), bcryptjs |
| Payments | Stripe |
| Maps & Geocoding | Google Maps Platform |
| Testing | Vitest (unit), k6 (load) |
| CI | GitHub Actions |
| Deployment | Google Kubernetes Engine (GKE Autopilot) |
| Container Registry | Google Artifact Registry |

---

## Architecture

LessGo uses a microservices architecture with an iOS frontend and ML-powered backend.

```
┌─────────────────────────────────────────────────────────────────┐
│                         iOS App (SwiftUI)                       │
│  DriverHomeView · RiderHomeView · TripDetailView · ActiveTrip   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway (Port 3000)                      │
│          JWT validation · Rate limiting · Routing               │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ Auth Service │   │   Trip Service   │   │ Booking Service  │
│   (3001)     │   │     (3003)       │   │     (3004)       │
└──────────────┘   └──────────────────┘   └──────────────────┘
        ▼                     ▼                     ▼
┌──────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ User Service │   │ Payment Service  │   │ Cost Calculation │
│   (3002)     │   │     (3005)       │   │     (3009)       │
└──────────────┘   └──────────────────┘   └──────────────────┘
        ▼                     ▼                     ▼
┌──────────────┐   ┌──────────────────┐   ┌──────────────────┐
│Notification  │   │ Safety Service   │   │  Embedding Svc   │
│   (3006)     │   │  (route/speed)   │   │   (Python ML)    │
└──────────────┘   └──────────────────┘   └──────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              PostgreSQL + PostGIS (Supabase)                    │
│        Users · Trips · Bookings · Messages · Payments           │
└─────────────────────────────────────────────────────────────────┘
```

Only the API Gateway is externally reachable. All other services communicate within the cluster via internal service headers.

---

## Project Structure

```
SJSU_Ridesharing/
├── LessGo/                       # iOS app
│   ├── LessGo/
│   │   ├── Views/                # SwiftUI views
│   │   ├── ViewModels/           # ObservableObject view models
│   │   ├── Models/               # Data models
│   │   ├── Services/             # API services
│   │   └── DesignSystem/         # UI components
│   └── LessGo.xcodeproj/
├── services/                     # Backend microservices
│   ├── api-gateway/              # Port 3000
│   ├── auth-service/             # Port 3001
│   ├── user-service/             # Port 3002
│   ├── trip-service/             # Port 3003
│   ├── booking-service/          # Port 3004
│   ├── payment-service/          # Port 3005
│   ├── notification-service/     # Port 3006
│   ├── cost-calculation-service/ # Port 3009
│   ├── embedding-service/        # ML embeddings (Python)
│   ├── routing-service/          # Route calculation (Python)
│   └── safety-service/           # Real-time safety monitoring
├── shared/                       # Shared types and utilities
│   ├── types/                    # TypeScript definitions
│   ├── middleware/               # Express middleware
│   └── utils/                    # Utility functions
├── db/migrations/                # Database migrations (20 applied)
├── k8s-manifests/                # Kubernetes manifests
├── tests/                        # Unit and load tests
├── docs/                         # Documentation
├── SETUP.md                      # Detailed setup guide
└── CLAUDE.md                     # Developer context
```

---

## Getting Started

### Prerequisites

- **iOS:** Xcode 15+, iOS 17+ simulator or device
- **Backend:** Node.js 22+, Docker (for Redis), Supabase account
- **ML Services:** Python 3.10+

### iOS App

```bash
git clone https://github.com/your-org/SJSU_Ridesharing.git
cd SJSU_Ridesharing/LessGo
open LessGo.xcodeproj
```

Select an iPhone 15 Pro simulator and press ⌘R to build and launch.

Demo credentials: `user1@sjsu.edu` / `Password123`

### Backend Services

```bash
# Install all workspace dependencies
npm install
cd shared && npm run build && cd ..

# Start Redis (PostgreSQL is on Supabase)
docker compose up -d

# Start all 8 services with named output
npm run dev:all
```

For full setup instructions including environment variables and DB bootstrapping, see [SETUP.md](SETUP.md).

### Configuration

Copy `.env.example` to `.env` in each service directory. Required variables:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Supabase PostgreSQL connection string |
| `JWT_SECRET` | Shared secret for JWT signing |
| `STRIPE_SECRET_KEY` | Stripe API key for payment processing |
| `GOOGLE_MAPS_API_KEY` | Maps and geocoding |
| `API_GATEWAY_URL` | External gateway URL (GKE-assigned) |

---

## Testing

```bash
# Unit tests (Vitest)
npm run test

# With coverage
npm run test:coverage

# Load tests (k6) — requires k6 installed
npm run test:load:commute   # Morning commute spike
npm run test:load:trips     # Concurrent active trips
npm run test:load:payments  # Payment burst
npm run test:load:all       # All scenarios

# Gateway smoke test
npm run test:gateway:smoke
```

---

## Seed Data

The database seed provides a realistic dataset for local development and demos:

- **50 users:** 25 drivers (with vehicles), 25 riders — all SJSU-verified
- **108 trips:**
  - 54 trips TO SJSU from Bay Area hubs (SF, Oakland, Fremont, Palo Alto, and more)
  - 54 trips FROM SJSU to Bay Area hubs
  - Morning rush (7–9 AM) TO SJSU; afternoon (3–7 PM) FROM SJSU

```bash
npm run seed
```

---

## Deployment

Backend services run on **Google Kubernetes Engine (GKE Autopilot)** using manifests in `k8s-manifests/`. GitHub Actions CI runs unit tests on every push and PR; the CD workflow builds and pushes Docker images to Google Artifact Registry on merge to main.

The iOS app is distributed via TestFlight for beta testing.

---

## API Reference

All routes are proxied through the API Gateway at the URL in `API_GATEWAY_URL`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Authenticate user, return JWT |
| POST | `/api/auth/register` | Register new user |
| GET | `/api/trips/search` | Search posted trips with pagination |
| POST | `/api/trips` | Create a new trip |
| PATCH | `/api/bookings/:id/approve` | Driver approves a booking |
| PATCH | `/api/bookings/:id/reject` | Driver rejects a booking |
| GET | `/api/bookings/:id` | Get booking status |
| POST | `/api/payments/capture` | Capture payment on trip completion |

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'feat: describe your change'`
4. Push the branch: `git push origin feature/your-feature`
5. Open a pull request

All tests must pass before a PR is merged. Follow the existing code style — TypeScript for services, Swift for iOS.

---

## License

To be determined

---

## Acknowledgments

- ML matching powered by RShareForm embeddings
- Database hosted on Supabase
- Payments processed by Stripe
- Maps and geocoding by Google Maps Platform
- Built for SJSU students, by SJSU students
