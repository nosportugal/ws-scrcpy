import { ManagerClient } from './ManagerClient';
import { Message } from '../../types/Message';
import { BaseDeviceDescriptor } from '../../types/BaseDeviceDescriptor';
import { DeviceTrackerEvent } from '../../types/DeviceTrackerEvent';
import { DeviceTrackerEventList } from '../../types/DeviceTrackerEventList';
import { html } from '../ui/HtmlTag';
import { ParamsDeviceTracker } from '../../types/ParamsDeviceTracker';
import { HostItem } from '../../types/Configuration';
import { Tool } from './Tool';
import Util from '../Util';
import { EventMap } from '../../common/TypedEmitter';
import NosInovacaoLogoSVG from '../../public/images/nos-inovacao-logo.svg';

const TAG = '[BaseDeviceTracker]';

export abstract class BaseDeviceTracker<DD extends BaseDeviceDescriptor, TE extends EventMap> extends ManagerClient<
    ParamsDeviceTracker,
    TE
> {
    public static readonly ACTION_LIST = 'devicelist';
    public static readonly ACTION_DEVICE = 'device';
    public static readonly HOLDER_ELEMENT_ID = 'devices';
    public static readonly AttributePrefixInterfaceSelectFor = 'interface_select_for_';
    public static readonly AttributePlayerFullName = 'data-player-full-name';
    public static readonly AttributePlayerCodeName = 'data-player-code-name';
    public static readonly AttributePrefixPlayerFor = 'player_for_';
    protected static tools: Set<Tool> = new Set();
    protected static instanceId = 0;

    public static registerTool(tool: Tool): void {
        this.tools.add(tool);
    }

    public static buildUrl(item: HostItem): URL {
        const { secure, port, hostname } = item;
        const pathname = item.pathname ?? '/';
        const protocol = secure ? 'wss:' : 'ws:';
        const url = new URL(`${protocol}//${hostname}${pathname}`);
        if (port) {
            url.port = port.toString();
        }
        return url;
    }

    public static buildUrlForTracker(params: HostItem): URL {
        const wsUrl = this.buildUrl(params);
        wsUrl.searchParams.set('action', this.ACTION);
        return wsUrl;
    }

    public static buildLink(q: any, text: string, params: ParamsDeviceTracker): HTMLAnchorElement {
        let { hostname } = params;
        let port: string | number | undefined = params.port;
        let pathname = params.pathname ?? location.pathname;
        let protocol = params.secure ? 'https:' : 'http:';
        if (params.useProxy) {
            q.hostname = hostname;
            q.port = port;
            q.pathname = pathname;
            q.secure = params.secure;
            q.useProxy = true;
            protocol = location.protocol;
            hostname = location.hostname;
            port = location.port;
            pathname = location.pathname;
        }
        const hash = `#!${new URLSearchParams(q).toString()}`;
        const a = document.createElement('a');
        a.setAttribute('href', `${protocol}//${hostname}:${port}${pathname}${hash}`);
        a.setAttribute('rel', 'noopener noreferrer');
        a.setAttribute('target', '_blank');
        a.classList.add(`link-${q.action}`);
        a.innerText = text;
        return a;
    }

    protected title = 'Device list';
    protected tableId = 'base_device_list';
    protected descriptors: DD[] = [];
    protected elementId: string;
    protected trackerName = '';
    protected id = '';
    private created = false;
    private messageId = 0;
    private ccBlocks: Map<string, { elementId: string; trackerName: string; descriptors: DD[] }> = new Map();

    protected constructor(params: ParamsDeviceTracker, protected readonly directUrl: string) {
        super(params);
        this.elementId = `tracker_instance${++BaseDeviceTracker.instanceId}`;
        this.trackerName = params.hostname ?? location.hostname;
        this.setBodyClass('list');
        this.setTitle();
    }

    public static parseParameters(params: URLSearchParams): ParamsDeviceTracker {
        const typedParams = super.parseParameters(params);
        const type = Util.parseString(params, 'type', true);
        if (type !== 'android' && type !== 'ios') {
            throw Error('Incorrect type');
        }
        return { ...typedParams, type };
    }

    protected getNextId(): number {
        return ++this.messageId;
    }

    private static sortDescriptors<D extends BaseDeviceDescriptor>(descriptors: D[]): D[] {
        return [...descriptors].sort((a, b) => {
            const aActive = a.state === 'device' ? 0 : 1;
            const bActive = b.state === 'device' ? 0 : 1;
            return aActive - bActive;
        });
    }

    protected buildDeviceTable(): void {
        const devices = this.getOrCreateTableHolder();
        const tbody = this.getOrBuildTableBody(devices);

        if (this.ccBlocks.size === 0) {
            // No CC blocks yet — render the initial placeholder using the legacy single-block path
            const block = this.getOrCreateTrackerBlock(tbody, this.trackerName, this.elementId);
            BaseDeviceTracker.sortDescriptors(this.descriptors).forEach((item) => {
                this.buildDeviceRow(block, item);
            });
            return;
        }

        for (const [, cc] of this.ccBlocks) {
            const block = this.getOrCreateTrackerBlock(tbody, cc.trackerName, cc.elementId);
            BaseDeviceTracker.sortDescriptors(cc.descriptors).forEach((item) => {
                this.buildDeviceRow(block, item);
            });
        }
    }

    private setNameValue(parent: Element | null, name: string, blockElementId: string): void {
        if (!parent) {
            return;
        }
        const nameBlockId = `${blockElementId}_name`;
        let nameEl = document.getElementById(nameBlockId);
        if (!nameEl) {
            nameEl = document.createElement('div');
            nameEl.id = nameBlockId;
            nameEl.className = 'tracker-name';
        }
        nameEl.innerText = name;
        parent.insertBefore(nameEl, parent.firstChild);
    }

    private getOrCreateTrackerBlock(parent: Element, controlCenterName: string, blockElementId: string): Element {
        let el = document.getElementById(blockElementId);
        if (!el) {
            el = document.createElement('div');
            el.id = blockElementId;
            parent.appendChild(el);
            if (blockElementId === this.elementId) {
                this.created = true;
            }
        } else {
            while (el.children.length) {
                el.removeChild(el.children[0]);
            }
        }
        this.setNameValue(el, controlCenterName, blockElementId);
        return el;
    }

    protected abstract buildDeviceRow(tbody: Element, device: DD): void;

    protected onSocketClose(event: CloseEvent): void {
        if (this.destroyed) {
            return;
        }
        console.log(TAG, `Connection closed: ${event.reason}`);
        setTimeout(() => {
            this.openNewConnection();
        }, 2000);
    }

    protected onSocketMessage(event: MessageEvent): void {
        let message: Message;
        try {
            message = JSON.parse(event.data);
        } catch (error: any) {
            console.error(TAG, error.message);
            console.log(TAG, error.data);
            return;
        }
        switch (message.type) {
            case BaseDeviceTracker.ACTION_LIST: {
                const evt = message.data as DeviceTrackerEventList<DD>;
                // Remove any stale ccBlocks for the same tracker name but a different id
                // (happens on server restart, which generates a new uptime-based id)
                for (const [staleId, staleBlock] of this.ccBlocks) {
                    if (staleId !== evt.id && staleBlock.trackerName === evt.name) {
                        const el = document.getElementById(staleBlock.elementId);
                        if (el) {
                            el.remove();
                        }
                        this.ccBlocks.delete(staleId);
                    }
                }
                this.getOrCreateCcBlock(evt.id, evt.name).descriptors = evt.list;
                this.setIdAndHostName(evt.id, evt.name);
                this.buildDeviceTable();
                break;
            }
            case BaseDeviceTracker.ACTION_DEVICE: {
                const evt = message.data as DeviceTrackerEvent<DD>;
                this.setIdAndHostName(evt.id, evt.name);
                this.updateDescriptor(evt.device, evt.id);
                this.buildDeviceTable();
                break;
            }
            default:
                console.log(TAG, `Unknown message type: ${message.type}`);
        }
    }

    protected setIdAndHostName(id: string, trackerName: string): void {
        if (this.id === id && this.trackerName === trackerName) {
            return;
        }
        this.id = id;
        this.trackerName = trackerName;
        const cc = this.ccBlocks.get(id);
        if (cc) {
            this.setNameValue(document.getElementById(cc.elementId), trackerName, cc.elementId);
        }
    }

    private static readonly PAGE_HEADER_ID = 'page-header';

    protected getOrCreateTableHolder(): HTMLElement {
        const id = BaseDeviceTracker.HOLDER_ELEMENT_ID;
        let devices = document.getElementById(id);
        if (!devices) {
            BaseDeviceTracker.getOrCreatePageHeader();
            devices = document.createElement('div');
            devices.id = id;
            devices.className = 'table-wrapper';
            document.body.appendChild(devices);
        }
        return devices;
    }

    private static getOrCreatePageHeader(): void {
        if (document.getElementById(BaseDeviceTracker.PAGE_HEADER_ID)) {
            return;
        }
        const header = document.createElement('header');
        header.id = BaseDeviceTracker.PAGE_HEADER_ID;
        const logoWrapper = document.createElement('span');
        logoWrapper.className = 'page-header-logo';
        logoWrapper.innerHTML = NosInovacaoLogoSVG;
        const divider = document.createElement('span');
        divider.className = 'page-header-divider';
        const title = document.createElement('span');
        title.className = 'page-header-title';
        title.textContent = 'Mobile Labs';
        header.appendChild(logoWrapper);
        header.appendChild(divider);
        header.appendChild(title);
        const rightLogo = document.createElement('span');
        rightLogo.className = 'page-header-right-logo';
        rightLogo.innerHTML = NosInovacaoLogoSVG;
        header.appendChild(rightLogo);
        document.body.prepend(header);
    }

    protected updateDescriptor(descriptor: DD, ccId?: string): void {
        const descriptors = ccId ? (this.ccBlocks.get(ccId)?.descriptors ?? this.descriptors) : this.descriptors;
        const idx = descriptors.findIndex((item: DD) => {
            return item.udid === descriptor.udid;
        });
        if (idx !== -1) {
            descriptors[idx] = descriptor;
        } else {
            descriptors.push(descriptor);
        }
    }

    private getOrCreateCcBlock(
        ccId: string,
        trackerName: string,
    ): { elementId: string; trackerName: string; descriptors: DD[] } {
        let cc = this.ccBlocks.get(ccId);
        if (!cc) {
            cc = {
                elementId: `tracker_instance${++BaseDeviceTracker.instanceId}`,
                trackerName,
                descriptors: [],
            };
            this.ccBlocks.set(ccId, cc);
        } else {
            cc.trackerName = trackerName;
        }
        return cc;
    }

    protected getOrBuildTableBody(parent: HTMLElement): Element {
        const className = 'device-list';
        let tbody = document.querySelector(
            `#${BaseDeviceTracker.HOLDER_ELEMENT_ID} #${this.tableId}.${className}`,
        ) as Element;
        if (!tbody) {
            const fragment = html`<div id="${this.tableId}" class="${className}"></div>`.content;
            parent.appendChild(fragment);
            const last = parent.children.item(parent.children.length - 1);
            if (last) {
                tbody = last;
            }
        }
        return tbody;
    }

    public getDescriptorByUdid(udid: string): DD | undefined {
        // Search across all CC blocks first
        for (const [, cc] of this.ccBlocks) {
            const found = cc.descriptors.find((descriptor: DD) => descriptor.udid === udid);
            if (found) {
                return found;
            }
        }
        if (!this.descriptors.length) {
            return;
        }
        return this.descriptors.find((descriptor: DD) => {
            return descriptor.udid === udid;
        });
    }

    public destroy(): void {
        super.destroy();
        // Remove all CC blocks
        for (const [, cc] of this.ccBlocks) {
            const el = document.getElementById(cc.elementId);
            if (el) {
                const { parentElement } = el;
                el.remove();
                if (parentElement && !parentElement.children.length) {
                    parentElement.remove();
                }
            }
        }
        if (this.created) {
            const el = document.getElementById(this.elementId);
            if (el) {
                const { parentElement } = el;
                el.remove();
                if (parentElement && !parentElement.children.length) {
                    parentElement.remove();
                }
            }
        }
        const holder = document.getElementById(BaseDeviceTracker.HOLDER_ELEMENT_ID);
        if (holder && !holder.children.length) {
            holder.remove();
        }
    }

    protected supportMultiplexing(): boolean {
        return true;
    }

    protected getChannelCode(): string {
        throw Error('Not implemented. Must override');
    }

    protected getChannelInitData(): Buffer {
        const code = this.getChannelCode();
        const buffer = Buffer.alloc(code.length);
        buffer.write(code, 'ascii');
        return buffer;
    }
}
