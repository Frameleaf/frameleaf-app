#pragma once
#include <atomic>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

// Deterministic SDK boundary fixture; this does not emulate Arm GPU inference.
namespace fixture {
inline int parsers = 0;
inline int runtimes = 0;
inline bool failLoad = false;
inline bool failExecute = false;
inline bool failExecuteStatus = false;
inline bool failUnload = false;
}
namespace armnn {
using NetworkId = int;
using LayerBindingId = int;
enum class Status { Success, Failure };
enum class LayerType { Input, Output };
enum class ShapeInferenceMethod { ValidateOnly, InferAndValidate };
enum class LogSeverity { Warning };
class InvalidArgumentException : public std::runtime_error { using std::runtime_error::runtime_error; };
template<class... T> void IgnoreUnused(const T&...) {}
inline void ConfigureLogging(bool, bool, LogSeverity) {}
struct TensorShape {
    unsigned int GetNumDimensions() const { return 2; }
    unsigned int operator[](unsigned int i) const { return i + 1; }
};
struct TensorInfo {
    TensorInfo() = default;
    TensorInfo(TensorShape, int, float, int, bool) {}
    TensorShape GetShape() const { return {}; }
    int GetDataType() const { return 0; }
    float GetQuantizationScale() const { return 1; }
    int GetQuantizationOffset() const { return 0; }
};
using BindingPointInfo = std::pair<LayerBindingId, TensorInfo>;
struct ConstTensor { const void* data; ConstTensor(TensorInfo, const void* p) : data(p) {} };
struct Tensor { void* data; Tensor(TensorInfo, void* p) : data(p) {} };
using InputTensors = std::vector<std::pair<int, ConstTensor>>;
using OutputTensors = std::vector<std::pair<int, Tensor>>;
struct BaseDescriptor {};
struct Slot { TensorInfo GetTensorInfo() const { return {}; } };
struct IConnectableLayer {
    LayerType type;
    LayerType GetType() const { return type; }
    Slot GetOutputSlot(int) const { return {}; }
    Slot GetInputSlot(int) const { return {}; }
};
struct IStrategy {
    virtual ~IStrategy() = default;
    virtual void ExecuteStrategy(const IConnectableLayer*, const BaseDescriptor&,
        const std::vector<ConstTensor>&, const char*, LayerBindingId) = 0;
};
struct INetwork {};
using INetworkPtr = std::unique_ptr<INetwork>;
struct IOptimizedNetwork {
    void ExecuteStrategy(IStrategy& strategy) {
        IConnectableLayer input{LayerType::Input}, output{LayerType::Output};
        strategy.ExecuteStrategy(&input, {}, {}, "input", 0);
        strategy.ExecuteStrategy(&output, {}, {}, "output", 1);
    }
};
using IOptimizedNetworkPtr = std::unique_ptr<IOptimizedNetwork>;
struct BackendId { explicit BackendId(const char*) {} };
struct BackendOptions {
    struct Option { template<class T> Option(const char*, T) {} };
    BackendOptions(const char*, std::initializer_list<Option>) {}
    void AddOption(Option) {}
};
struct OptimizerOptionsOpaque {
    void SetReduceFp32ToFp16(bool) {}
    void SetShapeInferenceMethod(ShapeInferenceMethod) {}
    void SetAllowExpandedDims(bool) {}
    void SetDebugToFileEnabled(bool) {}
    void SetProfilingEnabled(bool) {}
    void AddModelOption(BackendOptions) {}
};
struct IRuntime;
using IRuntimePtr = std::unique_ptr<IRuntime, void(*)(IRuntime*)>;
struct IRuntime {
    struct CreationOptions {
        struct { bool m_EnableProfiling; bool m_TimelineEnabled; } m_ProfilingOptions;
        std::vector<BackendOptions> m_BackendOptions;
    };
    static IRuntime* CreateRaw(const CreationOptions&) { ++fixture::runtimes; return new IRuntime; }
    static IRuntimePtr Create(const CreationOptions& options) { return {CreateRaw(options), Destroy}; }
    static void Destroy(IRuntime* runtime) { --fixture::runtimes; delete runtime; }
    int next = 0;
    Status LoadNetwork(NetworkId& id, IOptimizedNetworkPtr) {
        if (fixture::failLoad) { fixture::failLoad = false; throw InvalidArgumentException("load fault"); }
        id = next++;
        return Status::Success;
    }
    Status EnqueueWorkload(NetworkId, const InputTensors& input, const OutputTensors& output) {
        if (fixture::failExecute) { fixture::failExecute = false; throw std::runtime_error("enqueue fault"); }
        if (fixture::failExecuteStatus) { fixture::failExecuteStatus = false; return Status::Failure; }
        auto src = static_cast<const float*>(input[0].second.data);
        auto dst = static_cast<float*>(output[0].second.data);
        dst[0] = src[0]; dst[1] = src[1];
        return Status::Success;
    }
    Status UnloadNetwork(NetworkId) {
        if (fixture::failUnload) { fixture::failUnload = false; throw std::runtime_error("unload fault"); }
        return Status::Success;
    }
    int GetDeviceSpec() const { return 0; }
};
inline IOptimizedNetworkPtr Optimize(INetwork&, const std::vector<BackendId>&, int, const OptimizerOptionsOpaque&) {
    return std::make_unique<IOptimizedNetwork>();
}
}
namespace armnnDeserializer {
struct IDeserializer;
using IDeserializerPtr = std::unique_ptr<IDeserializer, void(*)(IDeserializer*)>;
struct IDeserializer {
    static IDeserializer* CreateRaw() { ++fixture::parsers; return new IDeserializer; }
    static IDeserializerPtr Create() { return {CreateRaw(), Destroy}; }
    static void Destroy(IDeserializer* parser) { --fixture::parsers; delete parser; }
    armnn::INetworkPtr CreateNetworkFromBinary(std::istream&) { return std::make_unique<armnn::INetwork>(); }
};
}
