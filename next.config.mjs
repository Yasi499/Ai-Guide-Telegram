/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    "/api/telegram": ["./ffmpeg-bin/ffmpeg"],
  },
};

export default nextConfig;
