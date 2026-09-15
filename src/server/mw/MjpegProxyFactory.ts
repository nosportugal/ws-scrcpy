import { Request, Response } from 'express';
import MjpegProxy from 'node-mjpeg-proxy';
import { WdaRunner } from '../appl-device/services/WDARunner';

export class MjpegProxyFactory {
    private static instances: Map<
        string,
        { proxy: MjpegProxy; wda: WdaRunner; consumers: number }
    > = new Map();
    private static starting: Map<string, Promise<{ proxy: MjpegProxy; wda: WdaRunner }>> = new Map();
    proxyRequest = async (req: Request, res: Response): Promise<void> => {
        const { udid } = req.params;
        if (!udid) {
            res.destroy();
            return;
        }
        let instance = MjpegProxyFactory.instances.get(udid);
        if (!instance) {
            let starting = MjpegProxyFactory.starting.get(udid);
            if (!starting) {
                starting = this.createInstance(udid);
                MjpegProxyFactory.starting.set(udid, starting);
            }
            try {
                const created = await starting;
                instance = MjpegProxyFactory.instances.get(udid);
                if (!instance) {
                    instance = { ...created, consumers: 0 };
                    MjpegProxyFactory.instances.set(udid, instance);
                }
            } catch (error: any) {
                console.error(`[MjpegProxyFactory] Failed to start WDA for udid "${udid}": ${error.message}`);
                res.destroy();
                return;
            } finally {
                MjpegProxyFactory.starting.delete(udid);
            }
        } else {
            WdaRunner.getInstance(udid);
        }
        instance.consumers++;
        let released = false;
        const release = (): void => {
            if (released) {
                return;
            }
            released = true;
            instance!.consumers--;
            instance!.wda.release();
            if (instance!.consumers === 0) {
                MjpegProxyFactory.instances.delete(udid);
            }
        };
        res.once('close', release);
        res.once('finish', release);
        instance.proxy.proxyRequest(req, res);
    };

    private createInstance = async (udid: string): Promise<{ proxy: MjpegProxy; wda: WdaRunner }> => {
        const wda = WdaRunner.getInstance(udid);
        try {
            await wda.start();
            const proxy = new MjpegProxy(`http://127.0.0.1:${wda.mjpegPort}`);
            proxy.on('error', (data: { msg: Error; url: string }): void => {
                console.error('msg: ' + data.msg);
                console.error('url: ' + data.url);
            });
            return { proxy, wda };
        } catch (error) {
            wda.release();
            throw error;
        }
    };
}
