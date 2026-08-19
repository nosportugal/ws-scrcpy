export interface NetInterface {
    name: string;
    ipv4: string;
    wifiFreqMHz?: number;
    wifiGeneration?: number | '6E';
}
