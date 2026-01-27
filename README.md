# ClassMate

Course schedule social matching platform for college students.

## Project Structure

```
classmate/
├── apps/
│   ├── web/          # React frontend (Vite + Tailwind)
│   └── api/          # Hono backend API
├── packages/
│   └── shared/       # Shared types and utilities
├── package.json      # Monorepo root
└── turbo.json        # Turborepo config
```

## Quick Start

```bash
# Install dependencies
npm install

# Start development servers
npm run dev

# Or start individually
npm run dev:web   # Frontend on http://localhost:5173
npm run dev:api   # Backend on http://localhost:3000
```

## Environment Variables

Create `.env` files in each app:

### apps/api/.env
```
SUPABASE_URL=your-supabase-url
SUPABASE_SERVICE_KEY=your-service-key
DOUBAO_API_KEY=your-doubao-api-key
DOUBAO_ENDPOINT_ID=doubao-seed-1-6-vision-250815
RESEND_API_KEY=your-resend-key
```

### apps/web/.env
```
VITE_API_URL=http://localhost:3000
VITE_SUPABASE_URL=your-supabase-url
VITE_SUPABASE_ANON_KEY=your-anon-key
```

## Tech Stack

- **Frontend**: React, TypeScript, Vite, Tailwind CSS, shadcn/ui
- **Backend**: Hono, TypeScript
- **Database**: Supabase (PostgreSQL)
- **AI**: Doubao Vision API (schedule parsing)
- **Email**: Resend
