interface Env {
  CLIENT_ASSETS?: R2Bucket;
  COMPANY_ASSETS?: R2Bucket;
  DB: D1Database;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_KEY: string;
  SUPABASE_BUCKET_NAME: string;
  WORKER_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

interface UploadResult {
  filename: string;
  supabase: { ok: boolean; error?: string; url?: string };
  r2: { ok: boolean; error?: string; path?: string };
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function verifyOrgMembership(token: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.github.com/user/memberships/orgs/losrecomendados', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const data = await res.json<{ state: string }>();
      return data.state === 'active';
    }
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    const userData = await userRes.json<{ login: string }>();
    const res2 = await fetch(`https://api.github.com/orgs/losrecomendados/members/${userData.login}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    return res2.status === 204;
  } catch {
    return false;
  }
}

async function auth(request: Request): Promise<string | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  return (await verifyOrgMembership(token)) ? token : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/api/health') return json({ status: 'ok' });

    // GitHub OAuth token exchange (no auth required)
    if (path === '/api/auth/github' && method === 'POST') {
      try {
        const body = await request.json<{ code: string }>();
        if (!body.code) return json({ error: 'Missing code' }, 400);

        if (!env.GITHUB_CLIENT_SECRET) {
          return json({ error: 'GitHub client secret not configured' }, 500);
        }

        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code: body.code,
          }),
        });

        const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
        if (!tokenData.access_token) {
          return json({ error: tokenData.error || 'Token exchange failed' }, 401);
        }

        const userRes = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github+json' },
        });
        const user = await userRes.json<{ login: string; avatar_url: string; id: number }>();

        return json({ access_token: tokenData.access_token, user });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : 'Auth failed' }, 500);
      }
    }

    // All /api routes require auth
    if (path.startsWith('/api/')) {
      if (!(await auth(request))) return json({ error: 'Unauthorized' }, 401);
    }

    // ── Clients CRUD ───────────────────────────────────
    if (path === '/api/clients' && method === 'GET') {
      const result = await env.DB.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
      return json(result.results);
    }

    if (path === '/api/clients' && method === 'POST') {
      const body = await request.json<{ name: string; contact_email?: string; phone?: string; notes?: string }>();
      const slug = slugify(body.name);
      const result = await env.DB.prepare(
        'INSERT INTO clients (name, slug, contact_email, phone, notes) VALUES (?, ?, ?, ?, ?) RETURNING *'
      ).bind(body.name, slug, body.contact_email ?? null, body.phone ?? null, body.notes ?? null).first();
      return json(result, 201);
    }

    const clientMatch = path.match(/^\/api\/clients\/(\d+)$/);
    if (clientMatch && method === 'GET') {
      const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientMatch[1]).first();
      if (!client) return json({ error: 'Not found' }, 404);
      const assets = await env.DB.prepare('SELECT * FROM assets WHERE client_id = ? ORDER BY uploaded_at DESC').bind(clientMatch[1]).all();
      return json({ ...client, assets: assets.results });
    }

    if (clientMatch && method === 'DELETE') {
      const id = clientMatch[1];
      const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
      if (!client) return json({ error: 'Not found' }, 404);
      const assets = await env.DB.prepare('SELECT key FROM assets WHERE client_id = ?').bind(id).all();
      for (const row of assets.results) await env.CLIENT_ASSETS.delete(row.key as string);
      await env.DB.prepare('DELETE FROM assets WHERE client_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(id).run();
      return json({ success: true });
    }

    // ── File Upload (dual: Supabase + R2) ──────────────
    if (path === '/api/upload' && method === 'POST') {
      const formData = await request.formData();
      const files = formData.getAll('files') as File[];
      const clientId = formData.get('client_id') as string | null;
      const bucketType = (formData.get('bucket') as string) || 'client';

      if (!files.length) return json({ error: 'No files provided' }, 400);

      const results: UploadResult[] = await Promise.all(
        files.map((file) => uploadFile(file, env, clientId, bucketType))
      );
      return json({ results });
    }

    // ── List files (from D1 metadata) ───────────────────
    if (path === '/api/files' && method === 'GET') {
      const clientId = url.searchParams.get('client_id');
      const bucketType = url.searchParams.get('bucket') || 'client';
      const bucketName = bucketType === 'company' ? 'company-assets' : 'client-assets';

      let query = 'SELECT * FROM assets WHERE bucket = ?';
      const params: string[] = [bucketName];
      if (clientId) {
        query += ' AND client_id = ?';
        params.push(clientId);
      }
      query += ' ORDER BY uploaded_at DESC';

      const stmt = env.DB.prepare(query);
      const result = clientId ? stmt.bind(bucketName, clientId) : stmt.bind(bucketName);
      const assets = await result.all();
      return json({ objects: assets.results });
    }

    // ── Download (via Supabase signed URL) ─────────────
    const dlMatch = path.match(/^\/api\/download\/(.+)$/);
    if (dlMatch && method === 'GET') {
      const assetId = dlMatch[1];
      const asset = await env.DB.prepare('SELECT * FROM assets WHERE id = ?').bind(assetId).first();
      if (!asset) return json({ error: 'Not found' }, 404);

      const signRes = await fetch(
        `${env.SUPABASE_URL}/storage/v1/object/sign/${env.SUPABASE_BUCKET_NAME}/${asset.key}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresIn: 3600 }),
        }
      );

      if (signRes.ok) {
        const { signedURL } = await signRes.json<{ signedURL: string }>();
        return Response.redirect(`${env.SUPABASE_URL}${signedURL}`, 302);
      }

      return json({ error: 'Could not generate download link' }, 500);
    }

    // ── Delete file ────────────────────────────────────
    if (path === '/api/files' && method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'Missing id' }, 400);

      const asset = await env.DB.prepare('SELECT * FROM assets WHERE id = ?').bind(id).first();
      if (!asset) return json({ error: 'Not found' }, 404);

      await env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(id).run();
      return json({ success: true });
    }

    return json({ error: 'Not found' }, 404);
  },
};

async function uploadFile(file: File, env: Env, clientId: string | null, bucketType: string): Promise<UploadResult> {
  const filename = `${Date.now()}-${file.name}`;
  const arrayBuffer = await file.arrayBuffer();
  const bucketName = bucketType === 'company' ? 'company-assets' : 'client-assets';
  const key = `${bucketType === 'company' ? 'company' : 'clients'}/${filename}`;

  const supabaseResult = await uploadToSupabase(filename, arrayBuffer, file.type, env);

  let r2Result: { ok: boolean; error?: string; path?: string } | undefined;
  const bucket = bucketType === 'company' ? env.COMPANY_ASSETS : env.CLIENT_ASSETS;
  if (bucket) {
    try {
      await bucket.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
      r2Result = { ok: true, path: key };
    } catch (err) {
      r2Result = { ok: false, error: err instanceof Error ? err.message : 'R2 upload failed' };
    }
  } else {
    r2Result = { ok: false, error: 'R2 not configured' };
  }

  // Record in D1 regardless of R2 status
  await env.DB.prepare(
    'INSERT INTO assets (client_id, bucket, key, filename, content_type, size) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    clientId ? parseInt(clientId) : null,
    bucketName,
    filename,
    file.name,
    file.type,
    file.size
  ).run();

  return { filename: file.name, supabase: supabaseResult, r2: r2Result };
}

async function uploadToSupabase(
  filename: string, data: ArrayBuffer, contentType: string, env: Env
): Promise<{ ok: boolean; error?: string; url?: string }> {
  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_BUCKET_NAME}/${filename}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: data,
  });

  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: `Supabase ${res.status}: ${body}` };
  }

  const signRes = await fetch(
    `${env.SUPABASE_URL}/storage/v1/object/sign/${env.SUPABASE_BUCKET_NAME}/${filename}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 31536000 }),
    }
  );

  if (signRes.ok) {
    const { signedURL } = await signRes.json<{ signedURL: string }>();
    return { ok: true, url: `${env.SUPABASE_URL}${signedURL}` };
  }

  return { ok: true };
}
