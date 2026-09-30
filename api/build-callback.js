'use strict';

const botModule = require('./bot');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, service: 'raven-build-callback' });
  try {
    const result = await botModule.handleBuildCallback(req.body || {});
    return res.status(200).json(result);
  } catch (error) {
    console.error('[BUILD CALLBACK]', error?.message || error);
    return res.status(400).json({ ok: false, error: 'invalid_callback' });
  }
};
