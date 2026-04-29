const express = require('express');
const app = express();
app.use(express.json());

const balances = {
  '123_LOC-1': { employeeId: '123', locationId: 'LOC-1', totalDays: 15.0 },
  '456_LOC-2': { employeeId: '456', locationId: 'LOC-2', totalDays: 10.0 }
};

app.get('/hcm/balance', (req, res) => {
  const { employeeId, locationId } = req.query;
  const key = `${employeeId}_${locationId}`;
  
  if (balances[key]) {
    res.json(balances[key]);
  } else {
    res.status(404).json({ error: 'Balance not found for user/location in HCM' });
  }
});

app.post('/hcm/request', (req, res) => {
  const { employeeId, locationId, daysRequested } = req.body;
  const key = `${employeeId}_${locationId}`;
  const balance = balances[key];

  if (!balance) return res.status(404).json({ status: 'REJECTED', reason: 'Employee not found' });

  
  if (balance.totalDays >= daysRequested) {
    balance.totalDays -= daysRequested;
    res.json({
      status: 'APPROVED',
      hcmReferenceId: `HCM-REQ-${Date.now()}`,
      newBalance: balance.totalDays
    });
  } else {
    res.json({
      status: 'REJECTED',
      reason: 'Insufficient balance in Source of Truth HCM',
      currentBalance: balance.totalDays
    });
  }
});


setInterval(() => {
  console.log('[HCM Simulator] Running anniversary accrual batch...');
  Object.keys(balances).forEach(key => {
    if (Math.random() > 0.5) {
      const addedDays = parseFloat((Math.random() * 2).toFixed(2));
      balances[key].totalDays += addedDays;
      console.log(`[Anniversary Event] Added ${addedDays} days to ${key}. New total: ${balances[key].totalDays.toFixed(2)}`);
    } else {
      console.log(`[HCM Simulator] No anniversary updates for ${key} this cycle.`);
    }
  });
}, 15000);

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
    console.log(`Mock HCM Server running on http://localhost:${PORT}`);
    console.log(`Available endpoints:`);
    console.log(`- GET /hcm/balance?employeeId=X&locationId=Y`);
    console.log(`- POST /hcm/request`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Mock HCM Server closed');
  });
});
process.on('SIGINT', () => {
  server.close(() => {
    console.log('Mock HCM Server closed');
  });
});
