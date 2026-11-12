import { gogAdapter } from "../gog/adapter";
import { rpcs3Adapter } from "../rpcs3/adapter";
import { PlatformAdapter } from "./platformAdapter";

// Each platform's adapter, by platform ID.
export const platformAdapters: Record<string, PlatformAdapter> = {
    [gogAdapter.platformId]: gogAdapter,
    [rpcs3Adapter.platformId]: rpcs3Adapter,
};
