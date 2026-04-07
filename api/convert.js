const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

let spotifyToken = null;
let tokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });

  const data = await res.json();
  spotifyToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spotifyToken;
}

function parseSpotifyUrl(url) {
  // https://open.spotify.com/track/2Ms33RTRCT6gArrpcrPxmo?si=...
  const match = url.match(/open\.spotify\.com\/(track|album)\/([a-zA-Z0-9]+)/);
  if (match) return { type: match[1], id: match[2] };
  return null;
}

function parseAppleMusicUrl(url) {
  // https://music.apple.com/us/album/album-name/123456?i=789 (track)
  // https://music.apple.com/us/album/album-name/123456 (album)
  const trackMatch = url.match(/music\.apple\.com\/\w+\/album\/[^/]+\/(\d+)\?i=(\d+)/);
  if (trackMatch) return { type: 'track', collectionId: trackMatch[1], trackId: trackMatch[2] };

  const albumMatch = url.match(/music\.apple\.com\/\w+\/album\/[^/]+\/(\d+)/);
  if (albumMatch) return { type: 'album', collectionId: albumMatch[1] };

  return null;
}

async function spotifyToApple(parsed) {
  const token = await getSpotifyToken();

  // Get track/album info from Spotify
  const res = await fetch(`https://api.spotify.com/v1/${parsed.type}s/${parsed.id}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!res.ok) throw new Error('Track not found on Spotify');
  const data = await res.json();

  let title, artist, thumbnail, isrc;

  if (parsed.type === 'track') {
    title = data.name;
    artist = data.artists.map(a => a.name).join(', ');
    thumbnail = data.album?.images?.[0]?.url || '';
    isrc = data.external_ids?.isrc;
  } else {
    title = data.name;
    artist = data.artists.map(a => a.name).join(', ');
    thumbnail = data.images?.[0]?.url || '';
  }

  // Search iTunes - try ISRC first for tracks, then fall back to text search
  let appleUrl = null;

  if (isrc) {
    const isrcRes = await fetch(`https://itunes.apple.com/lookup?isrc=${isrc}&entity=song&country=US`);
    const isrcData = await isrcRes.json();
    if (isrcData.resultCount > 0) {
      appleUrl = isrcData.results[0].trackViewUrl?.replace('https://music.apple.com', 'https://music.apple.com');
    }
  }

  if (!appleUrl) {
    const query = encodeURIComponent(`${data.name} ${data.artists?.[0]?.name || artist}`);
    const entity = parsed.type === 'track' ? 'song' : 'album';
    const searchRes = await fetch(`https://itunes.apple.com/search?term=${query}&entity=${entity}&country=US&limit=5`);
    const searchData = await searchRes.json();

    if (searchData.resultCount > 0) {
      appleUrl = parsed.type === 'track'
        ? searchData.results[0].trackViewUrl
        : searchData.results[0].collectionViewUrl;
    }
  }

  const spotifyUrl = parsed.type === 'track'
    ? `https://open.spotify.com/track/${parsed.id}`
    : `https://open.spotify.com/album/${parsed.id}`;

  return {
    title,
    artist,
    thumbnail,
    spotifyUrl,
    appleUrl,
    source: 'spotify',
  };
}

async function appleToSpotify(parsed) {
  // Look up the track/album on iTunes
  const lookupId = parsed.trackId || parsed.collectionId;
  const lookupRes = await fetch(`https://itunes.apple.com/lookup?id=${lookupId}&country=US`);
  const lookupData = await lookupRes.json();

  if (lookupData.resultCount === 0) throw new Error('Track not found on Apple Music');

  const item = lookupData.results[0];
  const title = item.trackName || item.collectionName;
  const artist = item.artistName;
  const thumbnail = (item.artworkUrl100 || '').replace('100x100', '600x600');

  const token = await getSpotifyToken();
  let spotifyUrl = null;

  // Try ISRC search first for tracks
  if (parsed.type === 'track') {
    // iTunes lookup doesn't return ISRC, so go straight to text search
    const query = encodeURIComponent(`track:${title} artist:${artist}`);
    const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=5`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const searchData = await searchRes.json();

    if (searchData.tracks?.items?.length > 0) {
      spotifyUrl = searchData.tracks.items[0].external_urls?.spotify;
    }
  } else {
    const query = encodeURIComponent(`album:${title} artist:${artist}`);
    const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${query}&type=album&limit=5`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const searchData = await searchRes.json();

    if (searchData.albums?.items?.length > 0) {
      spotifyUrl = searchData.albums.items[0].external_urls?.spotify;
    }
  }

  const appleUrl = parsed.trackId
    ? `https://music.apple.com/us/album/_/${parsed.collectionId}?i=${parsed.trackId}`
    : `https://music.apple.com/us/album/_/${parsed.collectionId}`;

  return {
    title,
    artist,
    thumbnail,
    spotifyUrl,
    appleUrl,
    source: 'apple',
  };
}

export default async function handler(req, res) {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');

  try {
    const spotify = parseSpotifyUrl(url);
    if (spotify) {
      const result = await spotifyToApple(spotify);
      return res.status(200).json(result);
    }

    const apple = parseAppleMusicUrl(url);
    if (apple) {
      const result = await appleToSpotify(apple);
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: 'Unrecognized URL. Please paste a Spotify or Apple Music link.' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Something went wrong' });
  }
}
