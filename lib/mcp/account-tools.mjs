import * as z from 'zod/v4';
import { validateVin, normalizeVin } from '../validate.mjs';
import { decodeVin as nhtsaDecode } from '../nhtsa.mjs';
import { verifyJwt } from '../auth.mjs';

export function accountTools(add, { db, JWT_SECRET }) {
  add('list_saved_vins',
    'List VINs saved by a user. Requires a user_token from /api/auth/login.',
    { user_token: z.string().describe('JWT token from website login') },
    async ({ user_token }) => {
      const user = verifyJwt(user_token, JWT_SECRET);
      if (!user) return { content: [{ type: 'text', text: 'Invalid or expired token' }], isError: true };
      const vins = db.prepare('SELECT id, vin, label, year, make, model, created_at FROM saved_vins WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
      return { content: [{ type: 'text', text: JSON.stringify(vins, null, 2) }] };
    }
  );

  add('save_vin',
    'Save a VIN to a user\'s collection with an optional label.',
    {
      user_token: z.string().describe('JWT token from website login'),
      vin: z.string().describe('17-character VIN to save'),
      label: z.optional(z.string()).describe('Custom label (e.g. "Dad\'s truck")'),
    },
    async ({ user_token, vin, label }) => {
      const user = verifyJwt(user_token, JWT_SECRET);
      if (!user) return { content: [{ type: 'text', text: 'Invalid or expired token' }], isError: true };
      if (!validateVin(vin).valid) return { content: [{ type: 'text', text: 'Provide a valid VIN (format and checksum)' }], isError: true };
      vin = normalizeVin(vin);
      if (label && label.length > 200) label = label.slice(0, 200);
      const decoded = await nhtsaDecode(vin);
      try {
        db.prepare('INSERT INTO saved_vins (user_id, vin, label, year, make, model) VALUES (?, ?, ?, ?, ?, ?)').run(
          user.id, vin, label || null, decoded?.vehicle?.year || null, decoded?.vehicle?.make || null, decoded?.vehicle?.model || null
        );
        return { content: [{ type: 'text', text: `Saved VIN ${vin}${label ? ` as "${label}"` : ''}` }] };
      } catch (e) {
        if (e.message.includes('UNIQUE')) return { content: [{ type: 'text', text: 'VIN already saved' }], isError: true };
        throw e;
      }
    }
  );

  add('remove_saved_vin',
    'Remove a VIN from the user\'s saved collection.',
    {
      user_token: z.string().describe('JWT token from website login'),
      vin: z.string().describe('VIN to remove'),
    },
    async ({ user_token, vin }) => {
      const user = verifyJwt(user_token, JWT_SECRET);
      if (!user) return { content: [{ type: 'text', text: 'Invalid or expired token' }], isError: true };
      const result = db.prepare('DELETE FROM saved_vins WHERE user_id = ? AND vin = ?').run(user.id, normalizeVin(vin));
      return { content: [{ type: 'text', text: result.changes ? 'Removed' : 'VIN not found in saved list' }] };
    }
  );

  add('get_output_preferences',
    'Get the user\'s VIN report output preferences.',
    { user_token: z.string().describe('JWT token') },
    async ({ user_token }) => {
      const user = verifyJwt(user_token, JWT_SECRET);
      if (!user) return { content: [{ type: 'text', text: 'Invalid or expired token' }], isError: true };
      db.prepare('INSERT OR IGNORE INTO output_preferences (user_id) VALUES (?)').run(user.id);
      const prefs = db.prepare('SELECT * FROM output_preferences WHERE user_id = ?').get(user.id);
      return { content: [{ type: 'text', text: JSON.stringify(prefs, null, 2) }] };
    }
  );

  const PREF_COLS = ['show_overview', 'show_engine', 'show_safety_ratings', 'show_fuel_economy', 'show_recalls', 'show_complaints', 'show_safety_equipment', 'show_photos', 'show_raw_nhtsa'];

  add('update_output_preferences',
    'Update which sections appear in VIN reports.',
    {
      user_token: z.string().describe('JWT token'),
      show_overview: z.optional(z.boolean()), show_engine: z.optional(z.boolean()),
      show_safety_ratings: z.optional(z.boolean()), show_fuel_economy: z.optional(z.boolean()),
      show_recalls: z.optional(z.boolean()), show_complaints: z.optional(z.boolean()),
      show_safety_equipment: z.optional(z.boolean()), show_photos: z.optional(z.boolean()),
      show_raw_nhtsa: z.optional(z.boolean()),
    },
    async ({ user_token, ...prefs }) => {
      const user = verifyJwt(user_token, JWT_SECRET);
      if (!user) return { content: [{ type: 'text', text: 'Invalid or expired token' }], isError: true };
      db.prepare('INSERT OR IGNORE INTO output_preferences (user_id) VALUES (?)').run(user.id);
      const sets = Object.entries(prefs).filter(([k, v]) => PREF_COLS.includes(k) && v !== undefined);
      if (sets.length === 0) return { content: [{ type: 'text', text: 'No changes provided' }] };
      const sql = `UPDATE output_preferences SET ${sets.map(([k]) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE user_id = ?`;
      db.prepare(sql).run(...sets.map(([, v]) => v ? 1 : 0), user.id);
      return { content: [{ type: 'text', text: 'Preferences updated' }] };
    }
  );

}
