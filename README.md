# LessGo - SJSU Ridesharing

> **Campus carpooling, reimagined.** ML-powered matching, SJSU-verified drivers, and rides that actually make sense for students.

---

## 🎬 Walkthrough & Demo

### 🎥 Full Walkthrough Video

<a href="https://youtu.be/l79FVVxRbPU" target="_blank">
  <img src="https://img.youtube.com/vi/l79FVVxRbPU/maxresdefault.jpg" alt="LessGo Walkthrough Video" width="800"/>
</a>

> Click the thumbnail above to watch the full walkthrough on YouTube.

### 📱 App Demo Simulation

<a href="https://youtube.com/shorts/KEm_HKYem6s?feature=share" target="_blank">
  <img src="https://img.youtube.com/vi/KEm_HKYem6s/maxresdefault.jpg" alt="LessGo App Demo" width="400"/>
</a>

> Click the thumbnail above to watch the app demo simulation on YouTube.

**Walkthrough covers:**
- Onboarding
- Searching and booking a ride as a rider
- Posting a trip as a driver
- Real-time chat and location tracking
- Stripe payment flow

---

## Why LessGo?

Uber and Lyft are great for city-wide rides, but they're not built for campus life. LessGo is different:

- **SJSU-only** — Every driver and rider is verified with a valid SJSU ID
- **Smart matching** — ML algorithms pair you with drivers going your way, not just whoever's closest
- **Posted rides** — Drivers post scheduled trips; you browse and book what works for your schedule
- **Student-friendly pricing** — Dynamic pricing that considers detours, not surge multipliers
- **Real-time everything** — Chat with your driver, track their location, get instant booking updates

LessGo connects SJSU students who are already going the same way. It's carpooling that actually works.

---

## Features

### 🧠 ML-Powered Matching
Our three-stage matching pipeline uses RShareForm HIN embeddings to rank trips by compatibility:
1. **PostGIS proximity filter** — Find trips within 5km and ±30 minutes
2. **Embedding similarity** — Rank by route compatibility using ML
3. **Scost optimization** — Balance detour distance, wait time, and social history

### 📱 Posted Rides Model
- Drivers post scheduled trips with origin, destination, and departure time
- Riders search and book rides that fit their schedule
- Bookings require driver approval — no surprise pickups
- Support for recurring trips and multi-passenger rides

### 🔐 SJSU ID Verification
- All users must verify with a valid SJSU student ID
- Verification powered by ML-based document processing
- Only verified users can post trips or book rides

### 💬 Real-Time Communication
- In-app chat between riders and drivers
- Real-time location tracking during active trips
- Push notifications for booking updates and trip status

### 💳 Seamless Payments
- Stripe-powered payment processing
- Automatic fare calculation based on distance and detours
- Secure payment capture only after trip completion

---

## Quick Start

### iOS App

1. **Clone and open in Xcode**
   ```bash
   git clone https://github.com/your-org/SJSU_Ridesharing.git
   cd SJSU_Ridesharing/LessGo
   open LessGo.xcodeproj
   ```

2. **Build and run**
   - Select iPhone 15 Pro simulator
   - Press ⌘R to build and launch

3. **Try it out**
   - Login with demo credentials: `user1@sjsu.edu` / `Password123`
   - Search for rides to/from SJSU
   - Book a ride and experience the flow

### Backend Services

1. **Install dependencies**
   ```bash
   npm install
   cd shared && npm run build && cd ..
   ```

2. **Start infrastructure**
   ```bash
   docker compose up -d  # Redis only (PostgreSQL is on Supabase)
   ```

3. **Run services**
   ```bash
   npm run dev:all  # Starts all 8 services at once
   ```

For detailed setup instructions, see [SETUP.md](SETUP.md).

---

## Architecture

LessGo uses a microservices architecture with an iOS frontend and ML-powered backend:

```
┌─────────────────────────────────────────────────────────────────┐
│                         iOS App (SwiftUI)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │  Rider   │  │  Driver  │  │   Chat   │  │  Profile │         │
│  │  Views   │  │  Views   │  │   View   │  │   View   │         │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      API Gateway (Port 3000)                    │
│    JWT validation · Rate limiting · Load Balancing· Routing     │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Auth Service │    │ Trip Service │    │Booking Svc   │
│   (3001)     │    │   (3003)     │    │   (3004)     │
└──────────────┘    └──────────────┘    └──────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PostgreSQL + PostGIS (Supabase)              │
│              Users · Trips · Bookings · Messages · Payments     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      ML Matching Pipeline                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │  Embedding   │  │   Matching   │  │   Routing    │           │
│  │   Service    │  │   Service    │  │   Service    │           │
│  │   (Python)   │  │  (TypeScript)│  │   (Python)   │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

### Tech Stack

**Frontend**
- Swift / SwiftUI
- MVVM architecture
- CoreLocation & MapKit
- Combine framework

**Backend**
- Node.js / TypeScript
- Express.js
- PostgreSQL + PostGIS
- Redis (caching)
- JWT authentication

**ML Pipeline**
- Python (embedding & routing services)
- RShareForm HIN embeddings
- PostGIS geospatial queries
- Custom matching algorithms

**Infrastructure**
- Google Kubernetes Engine (GKE)
- Supabase (database)
- Stripe (payments)
- Google Maps (geocoding)

---

## Project Structure

```
SJSU_Ridesharing/
├── LessGo/                          # iOS application
│   ├── LessGo/                      # Swift source files
│   │   ├── Core/                    # Feature modules
│   │   │   ├── Home/               # RiderHomeView, DriverHomeView
│   │   │   ├── Rider/              # Rider-specific views
│   │   │   ├── Driver/             # Driver-specific views
│   │   │   └── TripCreation/       # CreateTripView
│   │   ├── Models/                 # Data models
│   │   ├── Services/               # API services
│   │   └── DesignSystem/          # UI components
│   └── LessGo.xcodeproj/          # Xcode project
├── services/                       # Backend microservices
│   ├── api-gateway/                # Port 3000
│   ├── auth-service/               # Port 3001
│   ├── user-service/               # Port 3002
│   ├── trip-service/               # Port 3003
│   ├── booking-service/            # Port 3004
│   ├── payment-service/            # Port 3005
│   ├── notification-service/       # Port 3006
│   ├── cost-calculation-service/   # Port 3009
│   ├── embedding-service/          # ML embeddings (Python)
│   └── routing-service/            # Route calculation (Python)
├── shared/                         # Shared types and utilities
│   ├── types/                      # TypeScript definitions
│   ├── middleware/                 # Express middleware
│   └── utils/                      # Utility functions
├── db/migrations/                  # Database migrations
├── k8s-manifests/                  # Kubernetes manifests
├── tests/                          # Test scripts
├── docs/                           # Documentation
├── SETUP.md                        # Detailed setup guide
└── CLAUDE.md                       # Developer context
```

---

## Development

### Running Locally

**Backend:**
```bash
# Start all services at once
npm run dev:all

# Or start individually
cd services/api-gateway && npm run dev
cd services/auth-service && npm run dev
# ... etc for all 8 services
```

**iOS:**
```bash
# Open in Xcode
open LessGo/LessGo.xcodeproj

# Build and run (⌘R)
```

### Testing

```bash
# Run all backend tests
./tests/run-all-tests.sh --all

# Test iOS-specific features
./tests/test-ios-features.sh
```

### Database

```bash
# Run migrations
npm run bootstrap:db

# Fresh database with seed data
npm run bootstrap:db -- --fresh
```

---

## Demo Credentials

After running `npm run bootstrap:db -- --fresh`, the database contains:

**50 users:**
- Emails: `user1@sjsu.edu` through `user50@sjsu.edu`
- Password: `Password123`
- 25 drivers (with vehicles), 25 riders
- All SJSU-verified

**108 trips:**
- 54 trips TO SJSU from Bay Area hubs
- 54 trips FROM SJSU to Bay Area hubs
- Locations: SF, Oakland, Fremont, Palo Alto, and more
- Times: Morning rush (7–9 AM) for TO SJSU, afternoon (3–7 PM) for FROM SJSU

---

## Deployment

**Backend services** are deployed on Google Kubernetes Engine (GKE) using the manifests in `k8s-manifests/`. The CI/CD workflow builds and pushes Docker images to Google Artifact Registry on every commit.

**iOS app** is distributed via TestFlight for beta testing and will be submitted to the App Store for public release.

---

## Contributing

We welcome contributions! Here's how to get started:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Write tests for your changes
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

Please read our code style guidelines and ensure all tests pass before submitting.

---

## License

To be determined

---

## Acknowledgments

- Built for SJSU students, by SJSU students
- ML matching powered by RShareForm embeddings
- Database hosted on Supabase
- Payments processed by Stripe
- Maps and geocoding by Google Maps Platform

---

**Questions?** Open an issue or reach out to the team. Happy carpooling! 🚗
