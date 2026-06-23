# Serverless AI Workflow Architecture 🚀

Note for Recruiters & Tech Leads: Because my primary SaaS platforms (Boekly, Fermly, Dentuul, FarsNed) contain proprietary enterprise logic, encrypted multi-tenant data, and strict client NDAs, their full codebases are kept in Private repositories.This public repository serves as an architectural showcase of how I structure serverless AI integrations and edge functions.

🧠 The Architecture (Demo)
This repository contains a sanitized example of a serverless edge function used in my production SaaS environments. It demonstrates how to securely orchestrate LLMs (like Google Gemini or Anthropic Claude) alongside relational databases.

Core Principles Displayed Here:
* Edge-First Execution: Running AI integrations on the edge (Deno/Supabase) to reduce latency and keep API keys strictly server-side.
* LLM Tool-Calling / Structured Output: Forcing the AI model to return predictable, structured JSON so it can directly interface with Postgres databases.
* Security & Idempotency: Handling webhook verifications and ensuring database transactions are safe from race conditions.
* Graceful Degradation: Fallback mechanisms if the primary LLM API hits rate limits (429 errors).

🛠 Tech Stack
* Runtime: Deno / Serverless TypeScript
* Database: PostgreSQL (Supabase)
* AI Integration: OpenAI SDK / Google Gemini Models

I am always happy to provide a live screen-share walkthrough of my full CI/CD pipelines, RLS policies, and production databases during an interview.
