import { gogAdapter } from "../gog/adapter";
import { psnAdapter } from "../psn/adapter";
import { retroAdapter } from "../retro/adapter";
import { rpcs3Adapter } from "../rpcs3/adapter";
import { steamAdapter } from "../steam/adapter";
import { xboxAdapter } from "../xbox/adapter";
import { AnyPlatformAdapter } from "./platformAdapter";

// Each platform's adapter, by platform ID.
export const platformAdapters: Record<string, AnyPlatformAdapter> = {
    [gogAdapter.platformId]: gogAdapter,
    [psnAdapter.platformId]: psnAdapter,
    [retroAdapter.platformId]: retroAdapter,
    [rpcs3Adapter.platformId]: rpcs3Adapter,
    [steamAdapter.platformId]: steamAdapter,
    [xboxAdapter.platformId]: xboxAdapter,
};
