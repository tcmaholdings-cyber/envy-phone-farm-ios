import { chmod, mkdir, readlink, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The file an atomic save must replace. A release deploy links devices.json
 * (and device-secrets.json) to `shared/…`; renaming over the link itself would
 * swap it for a plain file inside that release and the next deploy would lose
 * every change, so resolve the link and replace the file it points at.
 */
export async function writeTarget(filePath: string): Promise<string> {
    try {
        return await realpath(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {  // a dangling link: create the file it names
        const link = await readlink(filePath);
        return path.resolve(path.dirname(filePath), link);
    } catch {
        return filePath;
    }
}

/** Replace `filePath` (or the file its symlink names) atomically, 0600 from the first byte. */
export async function writePrivateFileAtomic(filePath: string, content: string): Promise<void> {
    const target = await writeTarget(filePath);
    await mkdir(path.dirname(target), { recursive: true });
    const temporaryPath = `${target}.${process.pid}.tmp`;
    await writeFile(temporaryPath, content, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, target);
}
