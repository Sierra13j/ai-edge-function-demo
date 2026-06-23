/ Unified Hida matching engine.
// Used by: OpdrachtDetailDrawer ("Hida AI" tab), HidaSmartMatch widget,
// Hida page Smart Match, and (via proxy) hida-match-opdracht.
//
// Input:  { opdracht_id?: string, vacancy_id?: string, candidate_id?: string, force?: boolean }
// Output: { matches: [{ id, score, reason, criteria_scores, risks, next_action, candidate }], target }
//
// Single source of truth: same prompt, same model, same deterministic settings,
// so every surface ranks candidates identically.

import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL_PRIMARY = "google/gemini-2.5-pro";
const MODEL_FALLBACK = "google/gemini-2.5-flash";
const MAX_CANDIDATES_TO_SCORE = 40;

// -------- Deep context loader -----------------------------------------------

async function loadOpdrachtContext(supabase: any, opdracht_id: string) {
  const { data: op } = await supabase
    .from("opdrachten")
    .select("*")
    .eq("id", opdracht_id)
    .single();
  if (!op) return null;

  const [{ data: notes }, { data: linked }, { data: companyActs }] = await Promise.all([
    supabase
      .from("opdracht_notes")
      .select("event_type, content, created_at")
      .eq("opdracht_id", opdracht_id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("opdracht_candidates")
      .select("professional_id")
      .eq("opdracht_id", opdracht_id),
    op.company_id
      ? supabase
          .from("company_activities")
          .select("type, content, created_at")
          .eq("company_id", op.company_id)
          .order("created_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: [] }),
  ]);

  return {
    opdracht: op,
    notes: notes || [],
    excludeProfessionalIds: (linked || []).map((l: any) => l.professional_id),
    companyActivities: companyActs || [],
  };
}

async function loadVacancyContext(supabase: any, vacancy_id: string) {
  const { data: vac } = await supabase
    .from("vacancies")
    .select("*, companies(name, city, industry)")
    .eq("id", vacancy_id)
    .single();
  if (!vac) return null;
  const { data: apps } = await supabase
    .from("applications")
    .select("professional_id")
    .eq("vacancy_id", vacancy_id);
  return {
    vacancy: vac,
    excludeProfessionalIds: (apps || []).map((a: any) => a.professional_id),
  };
}

async function loadCandidatePool(supabase: any, excludeIds: string[]) {
  const { data: pros } = await supabase
    .from("professionals")
    .select(
      "id, first_name, last_name, city, postal_code, status, role_category, skills, tags, " +
        "education_level, education_field, certifications, languages, driving_license, " +
        "contract_preference, hours_preference_min, hours_preference_max, travel_distance_km, " +
        "salary_wish_min, salary_wish_max, salary_period, availability_date, " +
        "work_experience, hobbies, ai_profile_summary, notes, intake_notes, linkedin_url"
    )
    .in("status", ["Candidate", "Active"])
    .limit(300);

  const pool = (pros || []).filter((p: any) => !excludeIds.includes(p.id));
  if (pool.length === 0) return [];

  const ids = pool.map((p: any) => p.id);

  // Pull timeline + interview answers in two bulk queries.
  const [{ data: timeline }, { data: answers }] = await Promise.all([
    supabase
      .from("timeline_events")
      .select("candidate_id, type, content, created_at")
      .in("candidate_id", ids)
      .order("created_at", { ascending: false })
      .limit(600),
    supabase
      .from("interview_answers")
      .select("professional_id, answer, interview_kits(question)")
      .in("professional_id", ids)
      .limit(600),
  ]);

  const tlByCand: Record<string, any[]> = {};
  for (const ev of timeline || []) {
    const k = ev.candidate_id;
    if (!tlByCand[k]) tlByCand[k] = [];
    if (tlByCand[k].length < 8) tlByCand[k].push(ev);
  }
  const ansByCand: Record<string, any[]> = {};
  for (const a of answers || []) {
    const k = a.professional_id;
    if (!k) continue;
    if (!ansByCand[k]) ansByCand[k] = [];
    if (ansByCand[k].length < 10) ansByCand[k].push(a);
  }

  return pool.map((p: any) => ({
    ...p,
    _timeline: tlByCand[p.id] || [],
    _interview_answers: ansByCand[p.id] || [],
  }));
}

// -------- Prompt building ---------------------------------------------------

function summarizeCandidate(c: any): string {
  const parts: string[] = [];
  parts.push(`ID: ${c.id}`);
  parts.push(`Naam: ${c.first_name} ${c.last_name}`);
  parts.push(`Status: ${c.status} | Functie: ${c.role_category || "-"} | Stad: ${c.city || "-"}`);
  if (c.skills && Array.isArray(c.skills) && c.skills.length)
    parts.push(`Skills: ${JSON.stringify(c.skills)}`);
  if (c.certifications && Array.isArray(c.certifications) && c.certifications.length)
    parts.push(`Certificaten: ${JSON.stringify(c.certifications)}`);
  if (c.languages && Array.isArray(c.languages) && c.languages.length)
    parts.push(`Talen: ${JSON.stringify(c.languages)}`);
  if (c.education_level || c.education_field)
    parts.push(`Opleiding: ${c.education_level || "-"} ${c.education_field || ""}`.trim());
  if (c.driving_license) parts.push(`Rijbewijs: ${c.driving_license}`);
  if (c.contract_preference) parts.push(`Contractvoorkeur: ${c.contract_preference}`);
  if (c.hours_preference_min || c.hours_preference_max)
    parts.push(`Uren: ${c.hours_preference_min ?? "?"}-${c.hours_preference_max ?? "?"}/wk`);
  if (c.travel_distance_km) parts.push(`Reisbereidheid: ${c.travel_distance_km} km`);
  if (c.salary_wish_min || c.salary_wish_max)
    parts.push(
      `Salariswens: €${c.salary_wish_min ?? "?"}-${c.salary_wish_max ?? "?"} ${c.salary_period || ""}`
    );
  if (c.availability_date) parts.push(`Beschikbaar vanaf: ${c.availability_date}`);
  if (c.work_experience) {
    const we = typeof c.work_experience === "string"
      ? c.work_experience
      : JSON.stringify(c.work_experience);
    parts.push(`Werkervaring: ${we.slice(0, 1200)}`);
  }
  if (c.ai_profile_summary) {
    const s = typeof c.ai_profile_summary === "string"
      ? c.ai_profile_summary
      : JSON.stringify(c.ai_profile_summary);
    parts.push(`AI profielsamenvatting: ${s.slice(0, 1200)}`);
  }
  if (c.intake_notes) parts.push(`Intake: ${c.intake_notes.slice(0, 600)}`);
  if (c.notes) parts.push(`Notities: ${c.notes.slice(0, 600)}`);
  if (c.hobbies) {
    const h = typeof c.hobbies === "string" ? c.hobbies : JSON.stringify(c.hobbies);
    parts.push(`Hobbies: ${h.slice(0, 300)}`);
  }
  if (c._interview_answers?.length) {
    parts.push("Interview antwoorden:");
    for (const a of c._interview_answers.slice(0, 6)) {
      const q = a.interview_kits?.question || "?";
      parts.push(`  Q: ${q}\n  A: ${(a.answer || "").slice(0, 400)}`);
    }
  }
  if (c._timeline?.length) {
    parts.push("Recente timeline:");
    for (const t of c._timeline.slice(0, 5)) {
      parts.push(`  [${t.type}] ${(t.content || "").slice(0, 240)}`);
    }
  }
  return parts.join("\n");
}

function summarizeOpdracht(ctx: any): string {
  const o = ctx.opdracht;
  const lines: string[] = [];
  lines.push(`Titel: ${o.title}`);
  if (o.company_name) lines.push(`Opdrachtgever: ${o.company_name}`);
  if (o.location) lines.push(`Locatie: ${o.location}`);
  if (o.hours_per_week) lines.push(`Uren/week: ${o.hours_per_week}`);
  if (o.hourly_rate) lines.push(`Uurtarief: ${o.hourly_rate}`);
  if (o.start_date) lines.push(`Startdatum: ${o.start_date}`);
  if (o.end_date) lines.push(`Einddatum: ${o.end_date}`);
  if (o.priority) lines.push(`Prioriteit: ${o.priority}`);
  const desc = o.raw_description || o.description || o.public_description || "";
  if (desc) lines.push(`\nBeschrijving:\n${desc}`);
  if (ctx.notes?.length) {
    lines.push(`\nInterne notities:`);
    for (const n of ctx.notes.slice(0, 10))
      lines.push(`  [${n.event_type}] ${(n.content || "").slice(0, 300)}`);
  }
  if (ctx.companyActivities?.length) {
    lines.push(`\nRecente klantactiviteit:`);
    for (const a of ctx.companyActivities.slice(0, 5))
      lines.push(`  [${a.type}] ${(a.content || "").slice(0, 200)}`);
  }
  return lines.join("\n");
}

function summarizeVacancy(ctx: any): string {
  const v = ctx.vacancy;
  return [
    `Titel: ${v.title}`,
    v.companies?.name ? `Bedrijf: ${v.companies.name}` : "",
    v.location ? `Locatie: ${v.location}` : "",
    v.contract_type ? `Contract: ${v.contract_type}` : "",
    v.experience_level ? `Ervaringsniveau: ${v.experience_level}` : "",
    v.education_level ? `Opleiding: ${v.education_level}` : "",
    v.skills_required ? `Skills: ${JSON.stringify(v.skills_required)}` : "",
    v.description ? `\nBeschrijving:\n${v.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const SYSTEM_PROMPT = `Je bent Hida — senior recruitment en business manager bij Fermly met decennia ervaring in detachering en ZZP-bemiddeling. Je matcht professionals met opdrachten/vacatures als een topadviseur: nauwkeurig, eerlijk, en met scherp oog voor risico's én kansen.

WERKWIJZE:
1. Lees ALLE beschikbare context van de opdracht/vacature én van élke kandidaat (CV-data, werkervaring, AI-samenvatting, interviewantwoorden, timeline, hobbies, voorkeuren).
2. Beoordeel iedere kandidaat op zes criteria, ELK 0-100:
   - hard_skills: harde skills, certificaten, tools
   - experience: relevante werkervaring en domeinkennis
   - seniority: niveau-match (junior/medior/senior)
   - location: locatie, reisbereidheid, postcode
   - availability: beschikbaarheidsdatum, uren/week, contractvorm, tarief
   - soft_signals: motivatie, persoonlijkheid, teamfit, interviewantwoorden, recente notities
3. Bereken overall_score als gewogen gemiddelde (hard_skills 30%, experience 25%, seniority 10%, location 10%, availability 15%, soft_signals 10%), afgerond op heel getal 0-100.
4. Geef per kandidaat: korte reason (1-2 zinnen, concreet), risks (max 2 belangrijkste risico's), next_action (1 zin: wat zou je nu doen?).
5. Wees kritisch. Een kandidaat zonder duidelijk bewijs van een vereiste skill scoort daar laag. Verzin nooit ervaring die er niet staat.
6. Sorteer op overall_score (hoog → laag). Neem alleen kandidaten op met overall_score ≥ 25. Maximaal 12 resultaten.
7. Alles in het Nederlands.`;

// -------- AI call -----------------------------------------------------------

async function callAI(lovableKey: string, model: string, systemPrompt: string, userPrompt: string) {
  const tools = [
    {
      type: "function",
      function: {
        name: "rank_candidates",
        description: "Geef gerangschikte kandidaten met scores en onderbouwing.",
        parameters: {
          type: "object",
          properties: {
            matches: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  professional_id: { type: "string" },
                  overall_score: { type: "number" },
                  criteria_scores: {
                    type: "object",
                    properties: {
                      hard_skills: { type: "number" },
                      experience: { type: "number" },
                      seniority: { type: "number" },
                      location: { type: "number" },
                      availability: { type: "number" },
                      soft_signals: { type: "number" },
                    },
                    required: [
                      "hard_skills",
                      "experience",
                      "seniority",
                      "location",
                      "availability",
                      "soft_signals",
                    ],
                  },
                  reason: { type: "string" },
                  risks: { type: "array", items: { type: "string" } },
                  next_action: { type: "string" },
                },
                required: [
                  "professional_id",
                  "overall_score",
                  "criteria_scores",
                  "reason",
                  "risks",
                  "next_action",
                ],
              },
            },
          },
          required: ["matches"],
        },
      },
    },
  ];

  return await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      tools,
      tool_choice: { type: "function", function: { name: "rank_candidates" } },
      temperature: 0.2,
      max_tokens: 6000,
      reasoning: { effort: "medium" },
    }),
  });
}

// -------- Handler -----------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { opdracht_id, vacancy_id } = body || {};

    if (!opdracht_id && !vacancy_id) {
      return new Response(
        JSON.stringify({ error: "opdracht_id of vacancy_id is verplicht" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableKey = Deno.env.get("LOVABLE_API_KEY");
    if (!lovableKey) {
      return new Response(JSON.stringify({ error: "LOVABLE_API_KEY ontbreekt" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, serviceKey);

    // Load target context
    let targetSummary = "";
    let target: any = null;
    let excludeIds: string[] = [];

    if (opdracht_id) {
      const ctx = await loadOpdrachtContext(supabase, opdracht_id);
      if (!ctx) {
        return new Response(JSON.stringify({ error: "Opdracht niet gevonden" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      targetSummary = summarizeOpdracht(ctx);
      target = { kind: "opdracht", ...ctx.opdracht };
      excludeIds = ctx.excludeProfessionalIds;
    } else {
      const ctx = await loadVacancyContext(supabase, vacancy_id);
      if (!ctx) {
        return new Response(JSON.stringify({ error: "Vacature niet gevonden" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      targetSummary = summarizeVacancy(ctx);
      target = { kind: "vacancy", ...ctx.vacancy };
      excludeIds = ctx.excludeProfessionalIds;
    }

    // Load candidates with deep context
    const pool = await loadCandidatePool(supabase, excludeIds);
    if (!pool.length) {
      return new Response(
        JSON.stringify({ matches: [], target, message: "Geen beschikbare kandidaten." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Cap to manage token usage. Pool is already filtered on status; take first N.
    const scored = pool.slice(0, MAX_CANDIDATES_TO_SCORE);

    const candidateBlock = scored
      .map((c: any, i: number) => `\n=== KANDIDAAT ${i + 1} ===\n${summarizeCandidate(c)}`)
      .join("\n");

    const userPrompt =
      `## ${opdracht_id ? "OPDRACHT" : "VACATURE"}\n${targetSummary}\n\n` +
      `## KANDIDATEN (${scored.length})\n${candidateBlock}\n\n` +
      `Lever de rangschikking nu via de rank_candidates tool.`;

    // AI call with fallback on 429
    let aiRes = await callAI(lovableKey, MODEL_PRIMARY, SYSTEM_PROMPT, userPrompt);
    if (aiRes.status === 429) {
      aiRes = await callAI(lovableKey, MODEL_FALLBACK, SYSTEM_PROMPT, userPrompt);
    }

    if (!aiRes.ok) {
      const status = aiRes.status;
      const errText = await aiRes.text().catch(() => "");
      if (status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits zijn op. Voeg credits toe in Lovable instellingen." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (status === 429) {
        return new Response(
          JSON.stringify({ error: "Te druk, probeer het zo opnieuw." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      console.error("hida-match AI error", status, errText);
      return new Response(JSON.stringify({ error: `AI error: ${status}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiRes.json();
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    let parsed: any = { matches: [] };
    if (toolCall?.function?.arguments) {
      try {
        parsed = JSON.parse(toolCall.function.arguments);
      } catch (e) {
        console.error("Failed to parse tool args", e);
      }
    }

    const candById: Record<string, any> = {};
    for (const c of pool) candById[c.id] = c;

    const matches = (parsed.matches || [])
      .filter((m: any) => m.professional_id && candById[m.professional_id])
      .map((m: any) => {
        const c = candById[m.professional_id];
        return {
          // Legacy shape kept for existing UIs:
          id: m.professional_id,
          score: Math.round(m.overall_score || 0),
          reason: m.reason || "",
          candidate: {
            id: c.id,
            first_name: c.first_name,
            last_name: c.last_name,
            city: c.city,
            skills: c.skills,
            role_category: c.role_category,
          },
          // New rich fields:
          criteria_scores: m.criteria_scores || null,
          risks: m.risks || [],
          next_action: m.next_action || "",
        };
      })
      .sort((a: any, b: any) => b.score - a.score);

    return new Response(JSON.stringify({ matches, target }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("hida-match fatal", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
