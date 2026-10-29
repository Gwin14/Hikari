cmake_minimum_required(VERSION 3.22.1)
project(hikari_raw CXX C)

# LibRaw is fetched at configure time (dual-licensed LGPL 2.1 / CDDL 1.0; we use it under CDDL,
# which permits static linking). LibRaw-cmake provides the build description.
include(FetchContent)
set(FETCHCONTENT_QUIET ON)
FetchContent_Declare(libraw
  GIT_REPOSITORY https://github.com/LibRaw/LibRaw.git
  GIT_TAG 0.21.3
  GIT_SHALLOW TRUE)
FetchContent_Declare(libraw_cmake
  GIT_REPOSITORY https://github.com/LibRaw/LibRaw-cmake.git
  GIT_TAG master
  GIT_SHALLOW TRUE)
FetchContent_GetProperties(libraw)
if(NOT libraw_POPULATED)
  FetchContent_Populate(libraw)
endif()
FetchContent_GetProperties(libraw_cmake)
if(NOT libraw_cmake_POPULATED)
  FetchContent_Populate(libraw_cmake)
endif()

set(LIBRAW_PATH ${libraw_SOURCE_DIR} CACHE PATH "" FORCE)
set(ENABLE_OPENMP OFF CACHE BOOL "" FORCE)
set(ENABLE_LCMS OFF CACHE BOOL "" FORCE)
set(ENABLE_JASPER OFF CACHE BOOL "" FORCE)
set(ENABLE_EXAMPLES OFF CACHE BOOL "" FORCE)
set(ENABLE_RAWSPEED OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LIBRAW_INSTALL OFF CACHE BOOL "" FORCE)
add_subdirectory(${libraw_cmake_SOURCE_DIR} ${CMAKE_BINARY_DIR}/libraw)

add_library(hikari_raw SHARED hikari_raw.cpp)
target_include_directories(hikari_raw PRIVATE ${libraw_SOURCE_DIR})
target_link_libraries(hikari_raw raw_r log)
