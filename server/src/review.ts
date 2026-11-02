// A fixed login for Apple's (beta) app review, set with REVIEW_PHONE + REVIEW_CODE.
// Reviewers have no invisen sensor, so this account is a demo account: the app uses the
// simulated sensor for it, and it is hidden from other workers' team views.
import { config } from './config.js';
import { one, tx } from './db.js';

export const isReviewLogin = (phone: string, code: string) =>
  !!config.reviewPhone && !!config.reviewCode && phone === config.reviewPhone && code === config.reviewCode;

/** Creates (once) and returns the review worker in the first site. */
export async function ensureReviewWorker(): Promise<number> {
  const found = await one<{ id: number }>('select id from workers where phone = $1', [config.reviewPhone]);
  if (found) return found.id;
  return tx(async (c) => {
    const site = (await c.query<{ id: number }>('select id from sites order by id limit 1')).rows[0];
    if (!site) throw new Error('no site yet: run invisen-admin seed first');
    const zone = (await c.query<{ id: number }>('select id from zones where site_id = $1 and not is_rest order by id limit 1', [site.id])).rows[0];
    const id = (await c.query<{ id: number }>(
      `insert into workers (site_id, employee_no, name, phone, company, team, shift_name, shift_start, shift_end,
                            assigned_zone_ids, current_zone_id, current_spot, is_demo)
       values ($1, 'REVIEW-0001', '심사용 계정', $2, 'invisen', '데모', '데모 근무', '00:00', '23:59', $3, $4, 'A-01', true)
       returning id`,
      [site.id, config.reviewPhone, zone ? [zone.id] : [], zone?.id ?? null],
    )).rows[0].id;
    await c.query(`insert into sensors (id, battery, firmware) values ('IVS-DEMO-0001', 90, 'demo'), ('IVS-DEMO-0002', 70, 'demo') on conflict (id) do nothing`);
    return id;
  });
}
