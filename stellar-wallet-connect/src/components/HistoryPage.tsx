import React, { useState, useEffect } from 'react';
interface RoundHistory {
  round: number;
  winner: string;
  prizeAmount: string;
  date: string;
  txRef: string;
}
export const HistoryPage: React.FC = () => {
  const [history, setHistory] = useState<RoundHistory[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const mockData: RoundHistory[] = [
          { round: 3, winner: 'GBX7...2W4A', prizeAmount: '2,500 XLM', date: '2026-06-20', txRef: 'https://stellar.expert' },
          { round: 2, winner: 'GCP6...K9XL', prizeAmount: '1,850 XLM', date: '2026-06-13', txRef: 'https://stellar.expert' },
          { round: 1, winner: 'GD23...7PQR', prizeAmount: '1,200 XLM', date: '2026-06-06', txRef: 'https://stellar.expert' }
        ];
        setHistory(mockData);
        setLoading(false);
      } catch (e) {
        setLoading(false);
      }
    };
    fetchHistory();
  }, []);
  if (loading) return React.createElement('div', null, 'Loading history...');
  return React.createElement('div', { style: { padding: '2rem', fontFamily: 'sans-serif' } },
    React.createElement('h2', null, 'Prize Pool History'),
    React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse' } },
      React.createElement('thead', null,
        React.createElement('tr', null,
          React.createElement('th', null, 'Round'),
          React.createElement('th', null, 'Winner Address'),
          React.createElement('th', null, 'Prize Awarded'),
          React.createElement('th', null, 'Draw Date'),
          React.createElement('th', null, 'Transaction')
        )
      ),
      React.createElement('tbody', null,
        history.map((item) =>
          React.createElement('tr', { key: item.round },
            React.createElement('td', null, '#' + item.round),
            React.createElement('td', null, item.winner),
            React.createElement('td', null, item.prizeAmount),
            React.createElement('td', null, item.date),
            React.createElement('td', null,
              React.createElement('a', { href: item.txRef, target: '_blank', rel: 'noopener noreferrer' }, 'View Receipt →')
            )
          )
        )
      )
    )
  );
};