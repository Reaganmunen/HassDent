// Every response has the same envelope:  { success, data, meta? }  or  { success:false, error:{code,message,details?} }
const ok = (res, data, meta) => res.json({ success: true, data, ...(meta ? { meta } : {}) });
const created = (res, data) => res.status(201).json({ success: true, data });
const paged = (res, items, total, { limit, offset }) =>
  ok(res, items, { total, limit, offset, page: Math.floor(offset / limit) + 1, pages: Math.max(Math.ceil(total / limit), 1) });

/** Wrap an async handler so rejected promises reach the error middleware (Express 4 does not do this itself). */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { ok, created, paged, wrap };
