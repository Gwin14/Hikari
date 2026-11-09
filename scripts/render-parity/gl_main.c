// Renders a packed frame with the Android GLSL on the host's desktop OpenGL, driven by
// pipeline.gpu.test.ts. usage: harness <dir> <imageW> <imageH>; files vert, frag, source, curve, mask, frame.
#define GL_SILENCE_DEPRECATION
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *dir;

static unsigned char *load(const char *name, long *size) {
  char path[1024];
  snprintf(path, sizeof path, "%s/%s", dir, name);
  FILE *f = fopen(path, "rb");
  if (!f) { *size = 0; return NULL; }
  fseek(f, 0, SEEK_END);
  *size = ftell(f);
  rewind(f);
  unsigned char *b = malloc(*size + 1);
  fread(b, 1, *size, f);
  b[*size] = 0;
  fclose(f);
  return b;
}

static GLuint shader(GLenum type, const char *name) {
  long n;
  const char *text = (const char *)load(name, &n);
  GLuint s = glCreateShader(type);
  glShaderSource(s, 1, &text, NULL);
  glCompileShader(s);
  GLint ok;
  glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[8192];
    glGetShaderInfoLog(s, sizeof log, NULL, log);
    fprintf(stderr, "%s: %s\n", name, log);
    exit(1);
  }
  return s;
}

static GLuint texture(int unit, int w, int h, const unsigned char *pixels) {
  GLuint t;
  glGenTextures(1, &t);
  glActiveTexture(GL_TEXTURE0 + unit);
  glBindTexture(GL_TEXTURE_2D, t);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  return t;
}

int main(int argc, char **argv) {
  if (argc < 4) return 2;
  dir = argv[1];
  int W = atoi(argv[2]), H = atoi(argv[3]);
  CGLPixelFormatAttribute attrs[] = {kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_GL4_Core, 0};
  CGLPixelFormatObj pf;
  GLint count;
  CGLContextObj ctx;
  if (CGLChoosePixelFormat(attrs, &pf, &count) || CGLCreateContext(pf, NULL, &ctx) || CGLSetCurrentContext(ctx)) return 3;

  GLuint p = glCreateProgram();
  glAttachShader(p, shader(GL_VERTEX_SHADER, "vert"));
  glAttachShader(p, shader(GL_FRAGMENT_SHADER, "frag"));
  glLinkProgram(p);
  GLint ok;
  glGetProgramiv(p, GL_LINK_STATUS, &ok);
  if (!ok) {
    char log[8192];
    glGetProgramInfoLog(p, sizeof log, NULL, log);
    fprintf(stderr, "link: %s\n", log);
    return 1;
  }
  glUseProgram(p);

  GLuint vao, ubo, fbo, target;
  glGenVertexArrays(1, &vao);
  glBindVertexArray(vao);

  long n;
  unsigned char *src = load("source", &n);
  long cn;
  unsigned char *curve = load("curve", &cn);
  long mn;
  unsigned char *mask = load("mask", &mn);
  long fn;
  float *frame = (float *)load("frame", &fn);
  int floats = (int)(fn / 4);
  int locals = (int)frame[18];

  GLuint srcTex = texture(0, W, H, src);
  (void)srcTex;
  texture(1, 256, 1, curve);
  const char *names[] = {"uImage", "uBlurN", "uBlurS", "uBlurM", "uBlurL", "uLut"};
  for (int i = 0; i < 6; i++) glUniform1i(glGetUniformLocation(p, names[i]), 0);
  glUniform1i(glGetUniformLocation(p, "uCurve"), 1);

  GLuint arr;
  glGenTextures(1, &arr);
  glActiveTexture(GL_TEXTURE2);
  glBindTexture(GL_TEXTURE_2D_ARRAY, arr);
  glTexImage3D(GL_TEXTURE_2D_ARRAY, 0, GL_RGBA8, mn ? W : 1, mn ? H : 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, mn ? mask : NULL);
  glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glUniform1i(glGetUniformLocation(p, "uMasks"), 2);

  glUniform1fv(glGetUniformLocation(p, "uM"), 9, frame);
  glUniform2f(glGetUniformLocation(p, "uTarget"), W, H);
  glUniform2f(glGetUniformLocation(p, "uImageSize"), frame[19], frame[20]);
  glUniform1f(glGetUniformLocation(p, "uFlipY"), 0);
  glUniform1i(glGetUniformLocation(p, "uLocalCount"), locals);

  glGenBuffers(1, &ubo);
  glBindBuffer(GL_UNIFORM_BUFFER, ubo);
  GLint blockSize;
  GLuint block = glGetUniformBlockIndex(p, "Frame");
  glGetActiveUniformBlockiv(p, block, GL_UNIFORM_BLOCK_DATA_SIZE, &blockSize);
  float *data = calloc(blockSize, 1);
  memcpy(data, frame + 19, (floats - 19) * sizeof(float));
  glBufferData(GL_UNIFORM_BUFFER, blockSize, data, GL_STREAM_DRAW);
  glUniformBlockBinding(p, block, 0);
  glBindBufferBase(GL_UNIFORM_BUFFER, 0, ubo);

  glGenTextures(1, &target);
  glActiveTexture(GL_TEXTURE3);
  glBindTexture(GL_TEXTURE_2D, target);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, W, H, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glGenFramebuffers(1, &fbo);
  glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, target, 0);
  glViewport(0, 0, W, H);
  glClearColor(0, 0, 0, 0);
  glClear(GL_COLOR_BUFFER_BIT);
  glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);

  unsigned char *out = malloc(W * H * 4);
  glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, out);
  char path[1024];
  snprintf(path, sizeof path, "%s/out", dir);
  FILE *f = fopen(path, "wb");
  fwrite(out, 1, W * H * 4, f);
  fclose(f);
  return glGetError() == GL_NO_ERROR ? 0 : 4;
}
