import { gogAdapter } from "../gog/adapter";
import { rpcs3Adapter } from "../rpcs3/adapter";
import { steamAdapter } from "../steam/adapter";
import { xboxAdapter } from "../xbox/adapter";
import { PlatformAdapter } from "./platformAdapter";

// Each platform's adapter, by platform ID.
export const platformAdapters: Record<string, PlatformAdapter> = {
    [gogAdapter.platformId]: gogAdapter,
    [rpcs3Adapter.platformId]: rpcs3Adapter,
    [steamAdapter.platformId]: steamAdapter,
    [xboxAdapter.platformId]: xboxAdapter,
};
