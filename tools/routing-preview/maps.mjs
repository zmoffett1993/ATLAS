// Browser-only Maps credential is supplied at runtime, never in repository files.
let loading, map, geocoder, traffic, decorations = [];
const DEPOT = { lat: 33.9229391, lng: -117.931362 };
const COLORS = ["#1469ca", "#009e98", "#34a6e9", "#8a5fc4", "#d77b16"];

export function loadMaps(key) {
  if (loading) return loading;
  if (!/^AIza[\w-]{30,60}$/.test(key || "")) return Promise.reject(new Error("The preview's restricted Maps browser key is not configured yet."));
  loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const fail = message => { clearTimeout(timeout); script.remove(); reject(new Error(message)); };
    const timeout = setTimeout(() => fail("Google Maps did not finish loading. Check the preview's Maps configuration."), 20000);
    window.atlasPreviewMapsReady = () => { clearTimeout(timeout); resolve(window.google.maps); };
    window.gm_authFailure = () => fail("Google Maps rejected this preview address. Its browser-key restriction needs updating.");
    script.src = `https://maps.googleapis.com/maps/api/js?${new URLSearchParams({ key, v: "quarterly", loading: "async", callback: "atlasPreviewMapsReady", libraries: "geometry" })}`;
    script.async = true;
    script.nonce = document.querySelector("script[nonce]")?.nonce || "";
    script.onerror = () => fail("Google Maps could not load. No automatic retry was made.");
    document.head.appendChild(script);
  }).catch(error => { loading = null; throw error; });
  return loading;
}
export function clearRoutes() {
  decorations.forEach((item) => item.setMap(null)); decorations = [];
  if (map) { map.setCenter(DEPOT); map.setZoom(10); }
}
export async function showMap(key, element) {
  const maps = await loadMaps(key);
  if (!map || map.getDiv() !== element) {
    clearRoutes(); element.replaceChildren();
    map = new maps.Map(element, { center: DEPOT, zoom: 10, mapTypeControl: false, streetViewControl: false, fullscreenControl: true });
    traffic = new maps.TrafficLayer(); traffic.setMap(map);
  }
  geocoder ||= new maps.Geocoder();
  maps.event.trigger(map, "resize");
  return maps;
}
export async function locate(key, address) {
  await loadMaps(key); geocoder ||= new window.google.maps.Geocoder();
  try {
    const { results } = await geocoder.geocode({ address, componentRestrictions: { country: "US" } });
    return window.atlasRoutingPlanner.confirmedGeocode(results);
  } catch (error) {
    if (error.message?.startsWith("Address")) throw error;
    throw new Error("Address lookup failed or its quota was reached. Check the address and try again later.");
  }
}
export async function drawRoutes(key, element, plan, current = () => true) {
  const maps = await showMap(key, element);
  if (!current()) return;
  clearRoutes();
  const bounds = new maps.LatLngBounds(); bounds.extend(DEPOT);
  // Marker remains supported for the existing raster map; no new Map ID is required.
  decorations.push(new maps.Marker({ map, position: DEPOT, title: "Chubby Gorilla · Start & Finish", label: "★" }));
  for (const trip of plan.trips) {
    const color = COLORS[trip.tripIndex % COLORS.length];
    if (trip.polyline) {
      const path = maps.geometry.encoding.decodePath(trip.polyline);
      decorations.push(new maps.Polyline({ map, path, strokeColor: color, strokeWeight: 4, strokeOpacity: 0.9 }));
      path.forEach((point) => bounds.extend(point));
    }
    trip.visits.forEach((visit, index) => {
      const location = trip.locations[visit.stopIndex].location;
      const position = { lat: location.latitude, lng: location.longitude };
      bounds.extend(position);
      decorations.push(new maps.Marker({ map, position, label: String(index + 1), title: `Trip ${trip.tripIndex + 1} · ${trip.shipments[visit.stopIndex].customer}`,
        icon: { path: maps.SymbolPath.CIRCLE, scale: 13, fillColor: color, fillOpacity: 1, strokeWeight: 2, strokeColor: "#ffffff" } }));
    });
  }
  if (plan.trips.length) map.fitBounds(bounds, 35);
}
