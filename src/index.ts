#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';

// Define ToolContext type based on SDK's expectations
interface ToolContext {
    server: {
        config: ServerConfig;
    };
    request: {
        id: string;
    };
}

// --- Configuration ---
// Remove hardcoded API key
const GEOCODE_API_URL = "https://geocode.maps.co";
const CHARGENOW_API_URL = "https://chargenow.com/api/map/v1/de/query";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

// Add server configuration interface
interface ServerConfig {
    geocodeApiKey: string;
}

// Global variable to store the server config
let globalServerConfig: ServerConfig | null = null;

// Bounding box offset (degrees) - adjust as needed for desired search radius
const LAT_OFFSET = 0.005;
const LON_OFFSET = 0.005;

// --- Types ---
interface GeocodeResult {
    lat: string;
    lon: string;
    display_name: string;
}

interface ChargePoint {
    id: string;
}

interface ChargePool {
    id: string;
    longitude: number;
    latitude: number;
    chargePointCount: number;
    chargePoints: ChargePoint[];
    address?: string;
    name?: string;
    operator?: string;
}

interface ChargeNowClusterResponse {
    poolClusters: any[];
    pools: ChargePool[];
}

interface ChargePointStatus {
    dcsChargePointId: string;
    OperationalStateCP: "AVAILABLE" | "CHARGING" | "OFFLINE" | "UNKNOWN";
    Timestamp: string;
}

interface ChargeNowStatusResponse {
    DCSChargePointDynStatusResponse: ChargePointStatus[];
    ResponseStatus: {
        code: number;
        description: string;
        invalidDCSChargePointIdList: string[] | null;
    };
}

// Add ReverseGeocodeResult interface
interface ReverseGeocodeResult {
    place_id: number;
    licence: string;
    osm_type: string;
    osm_id: number;
    lat: string;
    lon: string;
    display_name: string;
    address: {
        road?: string;
        suburb?: string;
        city?: string;
        state?: string;
        postcode?: string;
        country?: string;
    };
    boundingbox: string[];
}

// Add new interfaces for pool details
interface PoolLocation {
    type: string;
    coordinates: {
        latitude: number;
        longitude: number;
    };
    street: string;
    zipCode: string;
    city: string;
    countryCode: string;
    poolLocationDescriptions: Array<{
        language: string;
        text: string;
    }>;
    poolLocationNames: Array<{
        language: string;
        name: string;
    }>;
}

interface Connector {
    plugType: string;
    cableAttached: string;
    phaseType: string;
    ampere: number;
    powerLevel: number;
    voltage: number;
}

interface ChargingStation {
    dcsCsId: string;
    incomingCsId: string;
    chargePoints: Array<{
        dcsCpId: string;
        incomingCpId: string;
        connectors: Connector[];
        dynamicInfoAvailable: boolean;
        isoNormedId: boolean;
    }>;
    chargingStationLocation: PoolLocation;
    chargingStationAuthMethods: string[];
}

interface PoolDetail {
    dcsPoolId: string;
    incomingPoolId: string;
    poolPaymentMethods: string[];
    poolLocations: PoolLocation[];
    poolContacts: Array<{
        name: string;
        phone: string;
    }>;
    chargingStations: ChargingStation[];
    technicalChargePointOperatorName: string;
    poolLocationType: string;
    access: string;
    open24h: boolean;
}

// --- Helper Functions ---

// Update getCoordinates to use config
async function getCoordinates(address: string, config: ServerConfig): Promise<{ lat: number; lon: number } | null> {
    const url = `${GEOCODE_API_URL}/search?q=${encodeURIComponent(address)}&api_key=${config.geocodeApiKey}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Geocode API error: ${response.status} ${response.statusText}`);
            return null;
        }
        const data = await response.json() as GeocodeResult[];
        if (data && data.length > 0) {
            const lat = parseFloat(data[0].lat);
            const lon = parseFloat(data[0].lon);
            if (!isNaN(lat) && !isNaN(lon)) {
                console.error(`Coordinates found for "${address}": ${lat}, ${lon}`);
                return { lat, lon };
            }
        }
        console.error(`No valid coordinates found for address: ${address}`);
        return null;
    } catch (error) {
        console.error("Error calling Geocode API:", error);
        return null;
    }
}

// Update reverseGeocode to use config
async function reverseGeocode(lat: number, lon: number, config: ServerConfig): Promise<string | null> {
    const url = `${GEOCODE_API_URL}/reverse?lat=${lat}&lon=${lon}&api_key=${config.geocodeApiKey}`;
    try {
        console.error(`Calling reverse geocode for coordinates: ${lat}, ${lon}`);
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Reverse Geocode API error: ${response.status} ${response.statusText}`);
            return null;
        }
        const data = await response.json() as ReverseGeocodeResult;
        console.error('Reverse geocode response:', JSON.stringify(data, null, 2));
        if (data && data.display_name) {
            return data.display_name;
        }
        console.error('No display_name in reverse geocode response');
        return null;
    } catch (error) {
        console.error("Error calling Reverse Geocode API:", error);
        return null;
    }
}

// Update getChargePools to use config
async function getChargePools(lat: number, lon: number, config: ServerConfig): Promise<ChargePool[]> {
    const latitudeNW = lat + LAT_OFFSET;
    const longitudeNW = lon - LON_OFFSET;
    const latitudeSE = lat - LAT_OFFSET;
    const longitudeSE = lon + LON_OFFSET;

    const body = JSON.stringify({
        searchCriteria: {
            latitudeNW,
            longitudeNW,
            latitudeSE,
            longitudeSE,
            precision: 7,
            unpackSolitudeCluster: false,
            unpackClustersWithSinglePool: true
        },
        withChargePointIds: true,
        filterCriteria: {}
    });

    try {
        const response = await fetch(CHARGENOW_API_URL, {
            method: 'POST',
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': 'application/json',
                'rest-api-path': 'clusters',
                'User-Agent': USER_AGENT
            },
            body: body
        });

        if (!response.ok) {
            console.error(`ChargeNow Cluster API error: ${response.status} ${response.statusText}`);
            return [];
        }
        const data = await response.json() as ChargeNowClusterResponse;
        console.error(`Found ${data.pools?.length ?? 0} charge pools nearby.`);

        // Add reverse geocoding for each pool
        const poolsWithAddresses = await Promise.all(data.pools.map(async pool => {
            const address = await reverseGeocode(pool.latitude, pool.longitude, config);
            return {
                ...pool,
                address: address || undefined
            };
        }));

        return poolsWithAddresses || [];
    } catch (error) {
        console.error("Error calling ChargeNow Cluster API:", error);
        return [];
    }
}

async function getChargePointStatuses(chargePointIds: string[]): Promise<ChargePointStatus[]> {
    if (chargePointIds.length === 0) {
        return [];
    }

    const body = JSON.stringify({
        DCSChargePointDynStatusRequest: chargePointIds.map(id => ({ dcsChargePointId: id }))
    });

    try {
        const response = await fetch(CHARGENOW_API_URL, {
            method: 'POST',
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': 'application/json',
                'rest-api-path': 'charge-points',
                'User-Agent': USER_AGENT
            },
            body: body
        });

        if (!response.ok) {
            console.error(`ChargeNow Status API error: ${response.status} ${response.statusText}`);
            return [];
        }
        const data = await response.json() as ChargeNowStatusResponse;
        console.error(`Retrieved status for ${data.DCSChargePointDynStatusResponse?.length ?? 0} charge points.`);
        return data.DCSChargePointDynStatusResponse || [];
    } catch (error) {
        console.error("Error calling ChargeNow Status API:", error);
        return [];
    }
}

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Add function to get pool details
async function getPoolDetails(poolIds: string[]): Promise<PoolDetail[]> {
    if (poolIds.length === 0) {
        return [];
    }

    const body = JSON.stringify({
        dcsPoolIds: poolIds,
        filterCriteria: {
            language: "en",
            fallbackLanguage: "de"
        }
    });

    try {
        const response = await fetch(CHARGENOW_API_URL, {
            method: 'POST',
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': 'application/json',
                'rest-api-path': 'pools',
                'User-Agent': USER_AGENT
            },
            body: body
        });

        if (!response.ok) {
            console.error(`ChargeNow Pool Details API error: ${response.status} ${response.statusText}`);
            return [];
        }
        const data = await response.json() as PoolDetail[];
        console.error(`Retrieved details for ${data.length} pools`);
        return data;
    } catch (error) {
        console.error("Error calling ChargeNow Pool Details API:", error);
        return [];
    }
}

// Update formatResults to use pool details
function formatResults(
    statuses: ChargePointStatus[], 
    pools: ChargePool[], 
    poolDetails: PoolDetail[],
    searchCoords: { lat: number, lon: number }, 
    address: string
): string {
    if (pools.length === 0 || statuses.length === 0) {
        return `No charge point statuses found near ${address}.`;
    }

    // Create a map of pool details by ID for easy lookup
    const poolDetailsMap = new Map(poolDetails.map(detail => [detail.dcsPoolId, detail]));

    // Group charge points by pool
    const poolMap = new Map<string, {
        pool: ChargePool,
        detail: PoolDetail | undefined,
        statuses: ChargePointStatus[],
        distance: number
    }>();

    // Process each pool
    pools.forEach(pool => {
        const distance = calculateDistance(
            searchCoords.lat,
            searchCoords.lon,
            pool.latitude,
            pool.longitude
        );

        const poolStatuses = statuses.filter(status => 
            pool.chargePoints.some(cp => cp.id === status.dcsChargePointId)
        );

        if (poolStatuses.length > 0) {
            poolMap.set(pool.id, {
                pool,
                detail: poolDetailsMap.get(pool.id),
                statuses: poolStatuses,
                distance
            });
        }
    });

    // Sort pools by distance
    const sortedPools = Array.from(poolMap.values())
        .sort((a, b) => a.distance - b.distance);

    // Format the output
    let summary = `Charging Stations near ${address}:\n\n`;

    // Overall statistics
    const totalAvailable = statuses.filter(s => s.OperationalStateCP === 'AVAILABLE').length;
    const totalCharging = statuses.filter(s => s.OperationalStateCP === 'CHARGING').length;
    const totalOffline = statuses.filter(s => s.OperationalStateCP === 'OFFLINE').length;
    
    summary += `Summary:\n`;
    summary += `• ${totalAvailable} charge points AVAILABLE\n`;
    summary += `• ${totalCharging} charge points in use (CHARGING)\n`;
    if (totalOffline > 0) summary += `• ${totalOffline} charge points OFFLINE\n`;
    summary += `\nDetailed Locations:\n`;

    // Detailed pool information
    sortedPools.forEach(({ pool, detail, statuses: poolStatuses, distance }) => {
        const availableCount = poolStatuses.filter(s => s.OperationalStateCP === 'AVAILABLE').length;
        const chargingCount = poolStatuses.filter(s => s.OperationalStateCP === 'CHARGING').length;
        const offlineCount = poolStatuses.filter(s => s.OperationalStateCP === 'OFFLINE').length;

        // Get location name from pool details
        const locationName = detail?.poolLocations[0]?.poolLocationNames[0]?.name || 'Charging Station';
        
        summary += `\n📍 ${locationName} (${distance.toFixed(2)} km)\n`;
        
        // Add detailed address if available
        if (detail?.poolLocations[0]) {
            const loc = detail.poolLocations[0];
            summary += `   Address: ${loc.street}, ${loc.zipCode} ${loc.city}\n`;
        }

        // Add operator info if available
        if (detail?.technicalChargePointOperatorName) {
            summary += `   Operator: ${detail.technicalChargePointOperatorName}\n`;
        }

        // Add payment methods if available
        if (detail?.poolPaymentMethods && detail.poolPaymentMethods.length > 0) {
            summary += `   Payment: ${detail.poolPaymentMethods.join(', ')}\n`;
        }

        // Add opening hours if available
        if (detail?.open24h !== undefined) {
            summary += `   Hours: ${detail.open24h ? '24/7' : 'Limited hours'}\n`;
        }

        // Add charging station details
        if (detail?.chargingStations) {
            const connectors = detail.chargingStations
                .flatMap(station => station.chargePoints)
                .flatMap(cp => cp.connectors);
            
            if (connectors.length > 0) {
                const connectorTypes = new Set(connectors.map(c => `${c.plugType} (${c.powerLevel}kW)`));
                summary += `   Connectors: ${Array.from(connectorTypes).join(', ')}\n`;
            }
        }
        
        summary += `   Status:\n`;
        summary += `   • ${availableCount} available points\n`;
        if (chargingCount > 0) summary += `   • ${chargingCount} points in use\n`;
        if (offlineCount > 0) summary += `   • ${offlineCount} points offline\n`;
        
        // Add last status update time if available
        const latestStatus = poolStatuses[0]?.Timestamp;
        if (latestStatus) {
            const updateTime = new Date(latestStatus).toLocaleTimeString();
            summary += `   Last updated: ${updateTime}\n`;
        }
    });

    return summary.trim();
}

// --- MCP Server Setup ---

const server = new McpServer({
    name: 'chargenow',
    version: '1.0.0',
    config: {
        schema: z.object({
            geocodeApiKey: z.string().describe('API key for geocoding service')
        })
    }
});

// Update the tool handler to use config
server.tool(
    'find_available_chargepoints',
    'Finds available electric vehicle charge points near a given address (street and city).',
    {
        address: z.string().describe('The street address and city (e.g., "Bautzener Str Berlin")')
    },
    async ({ address }, context: any): Promise<CallToolResult> => {
        console.error(`Tool called with address: ${address}`);
        console.error('Full context object:', JSON.stringify(context, null, 2));
        
        // Check if we have a config in the global variable
        if (!globalServerConfig) {
            // Try to extract config from context as fallback
            try {
                if (context?.server?.config?.geocodeApiKey) {
                    globalServerConfig = { geocodeApiKey: context.server.config.geocodeApiKey };
                    console.error("Extracted API key from context:", globalServerConfig.geocodeApiKey);
                }
            } catch (err) {
                console.error("Failed to extract API key from context:", err);
            }
            
            // If still no config, use a hardcoded fallback API key for testing
            if (!globalServerConfig) {
                globalServerConfig = { geocodeApiKey: "67fa4c6207dbe136695056tqk29b6f6" };
                console.error("Using fallback API key for testing");
            }
        }
        
        // Use the global config
        const config = globalServerConfig;
        console.error('Server config:', JSON.stringify(config, null, 2));
        
        if (!config || !config.geocodeApiKey) {
            console.error('Missing geocodeApiKey in config');
            return {
                content: [{ type: 'text', text: 'Error: Geocode API key is missing in server configuration.' }],
                isError: true
            };
        }

        // 1. Get Coordinates
        const coords = await getCoordinates(address, config);
        if (!coords) {
            return {
                content: [{ type: 'text', text: `Could not find coordinates for address: ${address}` }],
                isError: true,
            };
        }

        // 2. Get Charge Pools
        const pools = await getChargePools(coords.lat, coords.lon, config);
        if (pools.length === 0) {
            return {
                content: [{ type: 'text', text: `No charge pools found near ${address} (${coords.lat}, ${coords.lon})` }],
                isError: false,
            };
        }

        // 3. Get Pool Details
        const poolDetails = await getPoolDetails(pools.map(pool => pool.id));

        // 4. Get Charge Point IDs
        const chargePointIds = pools.flatMap(pool => pool.chargePoints.map(cp => cp.id));
        if (chargePointIds.length === 0) {
            return {
                content: [{ type: 'text', text: `Found charge pools, but no specific charge point IDs near ${address}` }],
                isError: false,
            };
        }
        console.error(`Found ${chargePointIds.length} charge point IDs.`);

        // 5. Get Statuses
        const statuses = await getChargePointStatuses(chargePointIds);

        // 6. Format Results with all available information
        const formattedResult = formatResults(statuses, pools, poolDetails, coords, address);

        return {
            content: [{ type: 'text', text: formattedResult }],
            isError: false,
        };
    }
);

// --- Start Server ---

async function main() {
    console.error("Starting ChargeNow MCP Server...");
    const transport = new StdioServerTransport();
    console.error("Created StdioServerTransport");
    
    try {
        await server.connect(transport);
        console.error("Server connected to transport");
        
        // Access and store the configuration from process.env
        const envGeoApiKey = process.env.GEOCODE_API_KEY;
        if (envGeoApiKey) {
            globalServerConfig = { geocodeApiKey: envGeoApiKey };
            console.error("Loaded API key from environment variable");
        } else {
            console.error("Warning: GEOCODE_API_KEY environment variable not found");
        }
        
        console.error("Server config:", JSON.stringify(globalServerConfig, null, 2));
    } catch (error) {
        console.error("Error connecting server:", error);
        process.exit(1);
    }
    
    console.error("ChargeNow MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
}); 