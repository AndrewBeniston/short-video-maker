import ffmpeg from "fluent-ffmpeg";
import { Readable } from "node:stream";
import { logger } from "../../logger";

export class FFMpeg {
  static async init(): Promise<FFMpeg> {
    return import("@ffmpeg-installer/ffmpeg").then((ffmpegInstaller) => {
      ffmpeg.setFfmpegPath(ffmpegInstaller.path);
      logger.info("FFmpeg path set to:", ffmpegInstaller.path);
      return new FFMpeg();
    });
  }

  async saveNormalizedAudio(
    audio: ArrayBuffer,
    outputPath: string,
  ): Promise<string> {
    logger.debug("Normalizing audio for Whisper");
    const inputStream = new Readable();
    inputStream.push(Buffer.from(audio));
    inputStream.push(null);

    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(inputStream)
        .audioCodec("pcm_s16le")
        .audioChannels(1)
        .audioFrequency(16000)
        .toFormat("wav")
        .on("end", () => {
          logger.debug("Audio normalization complete");
          resolve(outputPath);
        })
        .on("error", (error: unknown) => {
          logger.error(error, "Error normalizing audio:");
          reject(error);
        })
        .save(outputPath);
    });
  }

  async createMp3DataUri(audio: ArrayBuffer): Promise<string> {
    const inputStream = new Readable();
    inputStream.push(Buffer.from(audio));
    inputStream.push(null);
    return new Promise((resolve, reject) => {
      const chunk: Buffer[] = [];

      ffmpeg()
        .input(inputStream)
        .audioCodec("libmp3lame")
        .audioBitrate(128)
        .audioChannels(2)
        .toFormat("mp3")
        .on("error", (err) => {
          reject(err);
        })
        .pipe()
        .on("data", (data: Buffer) => {
          chunk.push(data);
        })
        .on("end", () => {
          const buffer = Buffer.concat(chunk);
          resolve(`data:audio/mp3;base64,${buffer.toString("base64")}`);
        })
        .on("error", (err) => {
          reject(err);
        });
    });
  }

  async saveToMp3(audio: ArrayBuffer, filePath: string): Promise<string> {
    const inputStream = new Readable();
    inputStream.push(Buffer.from(audio));
    inputStream.push(null);
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(inputStream)
        .audioCodec("libmp3lame")
        .audioBitrate(128)
        .audioChannels(2)
        .toFormat("mp3")
        .save(filePath)
        .on("end", () => {
          logger.debug("Audio conversion complete");
          resolve(filePath);
        })
        .on("error", (err) => {
          reject(err);
        });
    });
  }

  async getVideoMetadata(
    videoPath: string,
  ): Promise<{ duration: number; width: number; height: number }> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }
        const stream = metadata.streams.find((s) => s.width && s.height);
        resolve({
          duration: metadata.format?.duration ?? 0,
          width: stream?.width ?? 0,
          height: stream?.height ?? 0,
        });
      });
    });
  }

  async extractAudio(
    videoPath: string,
    wavOutput: string,
    mp3Output: string,
  ): Promise<number> {
    const meta = await this.getVideoMetadata(videoPath);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo()
        .audioCodec("pcm_s16le")
        .audioChannels(1)
        .audioFrequency(16000)
        .on("end", resolve)
        .on("error", reject)
        .save(wavOutput);
    });

    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo()
        .audioCodec("libmp3lame")
        .on("end", resolve)
        .on("error", reject)
        .save(mp3Output);
    });

    return meta.duration;
  }

  async mergeVideosWithTransitions(
    videos: string[],
    output: string,
    fadeDuration = 1,
  ): Promise<void> {
    const metas = await Promise.all(
      videos.map((v) => this.getVideoMetadata(v)),
    );
    return new Promise((resolve, reject) => {
      let command = ffmpeg();
      videos.forEach((v) => {
        command = command.addInput(v);
      });

      const filterParts: string[] = [];
      let offset = metas[0].duration - fadeDuration;
      filterParts.push(
        `[0:v][1:v]xfade=transition=fade:duration=${fadeDuration}:offset=${offset}[v1]`,
      );
      filterParts.push(`[0:a][1:a]acrossfade=d=${fadeDuration}[a1]`);

      for (let i = 2; i < videos.length; i++) {
        offset += metas[i - 1].duration - fadeDuration;
        filterParts.push(
          `[v${i - 1}][${i}:v]xfade=transition=fade:duration=${fadeDuration}:offset=${offset}[v${i}]`,
        );
        filterParts.push(
          `[a${i - 1}][${i}:a]acrossfade=d=${fadeDuration}[a${i}]`,
        );
      }

      const lastIndex = videos.length - 1;
      command
        .complexFilter(filterParts, [`v${lastIndex}`, `a${lastIndex}`])
        .outputOptions(["-map", `[v${lastIndex}]`, "-map", `[a${lastIndex}]`])
        .on("end", resolve)
        .on("error", reject)
        .save(output);
    });
  }
}
