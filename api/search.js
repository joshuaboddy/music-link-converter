import { getSpotifyToken } from './_spotify.js';

export default async function handler(req, res) {
  const { q } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Missing q parameter' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

  try {
    const token = await getSpotifyToken();
    const searchRes = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    if (!searchRes.ok) throw new Error('Spotify search failed');

    const data = await searchRes.json();
    const results = (data.tracks?.items || []).map(track => ({
      title: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      thumbnail: track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || '',
      spotifyId: track.id,
      spotifyUrl: track.external_urls?.spotify,
    }));

    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Search failed' });
  }
}
