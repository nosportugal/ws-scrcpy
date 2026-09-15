import { Request, Response } from 'express';
import MjpegProxy from 'node-mjpeg-proxy';
import { WdaRunner } from '../appl-device/services/WDARunner';

export class MjpegProxyFactory {
    private static instances: Map<
        string,
        { proxy: MjpegProxy; wda: WdaRunner; consumers: number }
    > = new Map();
    proxyRequest = async (req: Request, res: Response): Promise<void> => {
        const { udid } = req.params;
        if (!udid) {
            res.destroy();
            return;
        }
        let instance = MjpegProxyFactory.instances.get(udid);
        const wda = instance?.wda || WdaRunner.getInstance(udid);
        if (!instance) {
            try {
                await wda.start();
            } catch (error: any) {
                wda.release();
                console.error(`[MjpegProxyFactory] Failed to start WDA for udid "${udid}": ${error.message}`);
                res.destroy();
                return;
            }
            const port = wda.mjpegPort;
            const proxy = new MjpegProxy(`http://127.0.0.1:${port}`);
            proxy.on('error', (data: { msg: Error; url: string }): void => {
                console.error('msg: ' + data.msg);
                console.error('url: ' + data.url);
            });
            instance = { proxy, wda, consumers: 0 };
            MjpegProxyFactory.instances.set(udid, instance);
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
}
