/// One indexed log entry with a 256-dim embedding for IRIS Vector Search.
Class AdminDeck.Data.LogLine Extends %Persistent
{

Property File As %String(MAXLEN = 32) [ Required ];

Property LineNo As %Integer;

Property Ts As %String(MAXLEN = 32);

Property Pid As %Integer;

Property Severity As %Integer;

Property Source As %String(MAXLEN = 200);

Property Message As %String(MAXLEN = 2000);

Property Embedding As %Library.Vector(DATATYPE = "DOUBLE", LEN = 256);

Index FileIdx On File;

/// Approximate nearest-neighbour index for VECTOR_COSINE queries.
Index EmbeddingIdx On (Embedding) As %SQL.Index.HNSW(Distance = "Cosine");

Storage Default
{
<Data name="LogLineDefaultData">
<Value name="1">
<Value>%%CLASSNAME</Value>
</Value>
<Value name="2">
<Value>File</Value>
</Value>
<Value name="3">
<Value>LineNo</Value>
</Value>
<Value name="4">
<Value>Ts</Value>
</Value>
<Value name="5">
<Value>Pid</Value>
</Value>
<Value name="6">
<Value>Severity</Value>
</Value>
<Value name="7">
<Value>Source</Value>
</Value>
<Value name="8">
<Value>Message</Value>
</Value>
<Value name="9">
<Value>Embedding</Value>
</Value>
</Data>
<DataLocation>^AdminDeck.Data.LogLineD</DataLocation>
<DefaultData>LogLineDefaultData</DefaultData>
<IdLocation>^AdminDeck.Data.LogLineD</IdLocation>
<IndexLocation>^AdminDeck.Data.LogLineI</IndexLocation>
<StreamLocation>^AdminDeck.Data.LogLineS</StreamLocation>
<Type>%Storage.Persistent</Type>
}

}
