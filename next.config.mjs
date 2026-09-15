/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    "/api/telegram": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
};

export default nextConfig;
